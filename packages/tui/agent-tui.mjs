#!/usr/bin/env bun
// agent-tui — terminal chat UI for customer-agent.
// Run inside the web console terminal pane (or any real terminal):
//
//   cd ~/team-agent/customer-agent && bun run tui            # cwd = repo root
//   bun run tui /path/to/project                             # work in another dir
//
// Config via env (same as the server): AGENT_API_KEY, AGENT_MODEL_PROVIDER,
// AGENT_MODEL_ID, AGENT_BASE_URL.
import * as Core from "@agent/core";
import readline from "node:readline";
import { promises as fsp } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Sessions persist as JSON under ~/.customer-agent-tui (kept out of any
// project working tree). Deliberately NOT SQLiteSessionStore:
// better-sqlite3's native ABI breaks across bun/node versions; pure-JS
// storage makes the TUI runtime-agnostic.
const storeDir = `${os.homedir()}/.customer-agent-tui`;
await fsp.mkdir(storeDir, { recursive: true });
const sessionStore = new Core.FileSystemSessionStore(storeDir);


const C = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  magenta: (s) => `\x1b[35m${s}\x1b[0m`,
};

const workDir = path.resolve(process.argv[2] || process.cwd());
try {
  process.chdir(workDir);
} catch (err) {
  console.error(C.red(`✗ 无法进入工作目录 ${workDir}: ${err?.message ?? err}`));
  process.exit(1);
}
// Standard OSC 7 cwd notification for terminal/file-tree integrations.
process.stdout.write(`\x1b]7;${pathToFileURL(workDir).href}\x07`);
const apiKey = process.env.AGENT_API_KEY;
const provider = process.env.AGENT_MODEL_PROVIDER || "openai";
const modelId = process.env.AGENT_MODEL_ID || "gpt-4o";
const baseUrl = process.env.AGENT_BASE_URL || undefined;

if (!apiKey) {
  console.error(
    C.red("✗ AGENT_API_KEY 未设置。export AGENT_API_KEY=... （可参考 packages/server/.env.local）"),
  );
  process.exit(1);
}

const PROMPT = C.green("❯ ");
const showPrompt = () => process.stdout.write(PROMPT);

let rl = null;
let currentSessionId = null;
let running = false;
let agent = null;
/** set while ask_inline waits for a line; routes next input to the question */
let askWaiter = null;

function printBanner() {
  console.log();
  console.log(C.cyan("  ╭──────────────────────────────────────╮"));
  console.log(C.cyan("  │ ") + C.bold("customer-agent TUI") + C.cyan("                   │"));
  console.log(C.cyan("  ╰──────────────────────────────────────╯"));
  console.log(`  model    ${C.green(provider + "/" + modelId)}`);
  console.log(`  workdir  ${C.dim(workDir)}`);
  console.log(C.dim("  /help 查看命令 · Ctrl+C 中断回复，再按退出"));
  console.log();
}

async function newSession() {
  const now = new Date().toISOString();
  const session = await sessionStore.create({
    id: randomUUID(),
    projectId: "",
    title: "TUI 会话",
    status: "idle",
    messages: [],
    events: [],
    created: now,
    updated: now,
    metadata: { source: "tui" },
  });
  currentSessionId = session.id;
  console.log(C.dim(`── session ${session.id.slice(0, 8)} ──`));
}

/** Read sessions straight from the .sessions dir — store.list() is
 *  backed by an in-process cache, so cross-boot listings miss files. */
async function listSessions() {
  try {
    const dir = `${storeDir}/.sessions`;
    const files = (await fsp.readdir(dir)).filter((f) => f.endsWith(".json"));
    if (files.length === 0) return console.log(C.dim("(还没有会话)"));
    const rows = [];
    for (const f of files) {
      try {
        const s = JSON.parse(await fsp.readFile(`${dir}/${f}`, "utf8"));
        rows.push({ id: s.id, title: s.title || s.id?.slice(0, 8), created: s.created ?? "" });
      } catch {}
    }
    rows.sort((a, b) => b.created.localeCompare(a.created));
    for (const s of rows.slice(0, 12)) {
      const marker = s.id === currentSessionId ? C.green("●") : C.dim("○");
      console.log(`${marker} ${C.bold(s.title)}  ${C.dim(s.created.slice(0, 16).replace("T", " "))}  ${C.dim(s.id.slice(0, 8))}`);
    }
  } catch {
    console.log(C.dim("(还没有会话)"));
  }
}

async function openSession(idPrefix) {
  try {
    const dir = `${storeDir}/.sessions`;
    const files = (await fsp.readdir(dir)).filter((f) => f.endsWith(".json") && f.startsWith(idPrefix));
    if (files.length === 0) return console.log(C.red(`✗ 找不到会话 ${idPrefix}`));
    currentSessionId = files[0].replace(/\.json$/, "");
    console.log(C.dim(`── session ${currentSessionId.slice(0, 8)} ──`));
  } catch {
    console.log(C.red(`✗ 找不到会话 ${idPrefix}`));
  }
}

function renderEvent(event) {
  switch (event.type) {
    case "text_chunk":
      process.stdout.write(event.text);
      break;
    case "text_done":
      process.stdout.write("\n");
      break;
    case "tool_call": {
      const name = event.toolCall?.name ?? "tool";
      const args =
        typeof event.toolCall?.arguments === "string"
          ? event.toolCall.arguments.replace(/\s+/g, " ").slice(0, 90)
          : JSON.stringify(event.toolCall?.arguments ?? {}).slice(0, 90);
      console.log(`  ${C.magenta("⚙ " + name)} ${C.dim(args)}`);
      break;
    }
    case "tool_result": {
      const c = String(event.result?.content ?? "");
      const flat = c.replace(/\s+/g, " ").slice(0, 130);
      if (event.result?.isError) console.log(`  ${C.red("✗ " + flat)}`);
      else console.log(`  ${C.dim("↳ " + flat + (c.length > 130 ? "…" : ""))}`);
      break;
    }
    case "error":
      process.stdout.write("\n");
      console.log(`  ${C.red("✗ " + event.message)}`);
      break;
    case "done":
      if (event.usage) {
        const u = event.usage;
        const up = u.inputTokens ?? u.promptTokens ?? "?";
        const down = u.outputTokens ?? u.completionTokens ?? "?";
        console.log(C.dim(`  [tokens ↑${up} ↓${down}]`));
      }
      break;
    default:
      break;
  }
}

/** Inline ask_user: route submitted lines here until a non-empty answer. */
function askInline(request) {
  return new Promise((resolve) => {
    const print = () => {
      console.log(C.yellow("❓ " + request.question));
      (request.options ?? []).forEach((o, i) =>
        console.log(`   ${C.bold(i + 1)}. ${o.label}${o.description ? C.dim(" — " + o.description) : ""}`),
      );
      (request.fields ?? []).forEach((f) =>
        console.log(`   • ${f.label || f.name}${f.type === "secret" ? C.dim("（敏感）") : ""}`),
      );
      showPrompt();
    };
    const arm = () => {
      askWaiter = (raw) => {
        const answer = raw.trim();
        if (!answer) {
          console.log(C.dim("(请输入内容或序号)"));
          print();
          arm();
          return;
        }
        if (request.options?.length) {
          const idx = parseInt(answer, 10);
          if (Number.isInteger(idx) && idx >= 1 && idx <= request.options.length) {
            return resolve({ answer: request.options[idx - 1].label });
          }
        }
        resolve({ answer });
      };
    };
    print();
    arm();
  });
}

async function runTurn(input) {
  running = true;
  try {
    agent = await new Core.AgentBuilder()
      .withWorkingDirectory(workDir)
      .withSessionStore(sessionStore)
      .withModel(provider, { apiKey, modelId, baseUrl })
      .withTool(new Core.AskUserTool(async (request) => await askInline(request)))
      .build();

    for await (const event of agent.run(input, currentSessionId)) {
      if (event.type === "ask_user") continue; // answered synchronously by the tool callback
      renderEvent(event);
    }
  } catch (err) {
    console.log();
    console.log(`  ${C.red("✗ " + (err?.message ?? String(err)))}`);
  } finally {
    running = false;
    agent = null;
  }
}

function showHelp() {
  console.log(
    C.dim([
      "  /new              新建会话",
      "  /sessions         列出最近会话",
      "  /open <id前缀>    切换到指定会话",
      "  /cwd              显示当前工作目录",
      "  /model            显示当前模型",
      "  /help             本帮助",
      "  /exit             退出（Ctrl+D 同效）",
    ].join("\n")),
  );
}

async function handleCommand(lineRaw) {
  const line = lineRaw.trim();
  if (!line) return;

  if (line.startsWith("/")) {
    const [cmd, ...rest] = line.split(/\s+/);
    switch (cmd) {
      case "/help": showHelp(); break;
      case "/new": await newSession(); break;
      case "/sessions": await listSessions(); break;
      case "/open":
        if (!rest[0]) console.log(C.red("用法: /open <id前缀>"));
        else await openSession(rest[0]);
        break;
      case "/cwd": console.log(workDir); break;
      case "/model": console.log(`${provider}/${modelId}`); break;
      case "/exit": rl.close(); return;
      default: console.log(C.red(`未知命令 ${cmd}，/help 查看`));
    }
    return;
  }

  if (!currentSessionId) await newSession();
  await runTurn(line);
}

async function main() {
  printBanner();
  await newSession();

  rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: PROMPT,
    terminal: true,
  });

  rl.on("line", async (line) => {
    // ask_user answers take priority over everything
    if (askWaiter) {
      const w = askWaiter;
      askWaiter = null;
      w(line);
      return;
    }
    if (running) return; // ignore stray input while streaming
    try {
      await handleCommand(line);
    } catch (err) {
      console.log(C.red(`✗ ${err?.message ?? err}`));
    }
    showPrompt();
  }).on("close", () => {
    console.log(C.dim("\nbye 👋"));
    process.exit(0);
  });

  process.on("SIGINT", () => {
    if (running && agent) {
      agent.abort();
      console.log(C.yellow("\n  ⏹ 已中断当前回复"));
      showPrompt();
    } else {
      console.log(C.dim("\nbye 👋"));
      process.exit(0);
    }
  });

  showPrompt();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
