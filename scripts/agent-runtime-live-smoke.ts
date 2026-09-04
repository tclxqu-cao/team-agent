#!/usr/bin/env bun
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentEvent } from "@agent/core";
import type { AgentRuntimeAdapter, UnifiedSessionDetail } from "../packages/desktop/main/agent-runtime/types.js";

export type SmokeAgent = "codex" | "claude" | "opencode";
export type SmokeFailureCategory = "compatibility" | "authentication" | "rate_limit" | "registry" | "runner" | "unknown";

export interface SmokeCapabilities {
  goal?: boolean;
  steer?: boolean;
  fork?: boolean;
  archive?: boolean;
}

export interface SmokeStepResult {
  name: string;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  category?: SmokeFailureCategory;
}

export interface SmokeSummary {
  schemaVersion: 1;
  agent: SmokeAgent;
  runtimeVersion?: string;
  success: boolean;
  startedAt: string;
  durationMs: number;
  capabilities: SmokeStepResult[];
  failureCategory?: SmokeFailureCategory;
  failure?: string;
}

interface SmokeOptions {
  agent: SmokeAgent;
  adapter: AgentRuntimeAdapter;
  workspaceRoot: string;
  expectedVersion?: string;
  capabilities?: SmokeCapabilities;
  eventTimeoutMs?: number;
  historyTimeoutMs?: number;
  abortDelayMs?: number;
  now?: () => number;
}

interface CollectedRun {
  events: AgentEvent[];
  textSeen: boolean;
  permissionSeen: boolean;
  terminal: "done" | "turn_aborted" | "interrupted";
}

const DEFAULT_CAPABILITIES: Record<SmokeAgent, SmokeCapabilities> = {
  codex: { goal: true, steer: true, fork: true, archive: true },
  claude: { goal: true, steer: true },
  opencode: { fork: true },
};

export async function runAgentRuntimeSmoke(options: SmokeOptions): Promise<SmokeSummary> {
  const now = options.now ?? Date.now;
  const started = now();
  const startedAt = new Date(started).toISOString();
  const steps: SmokeStepResult[] = [];
  const timeoutMs = options.eventTimeoutMs ?? 120_000;
  const capabilities = options.capabilities ?? DEFAULT_CAPABILITIES[options.agent];
  let runtimeVersion: string | undefined;
  let workspace: string | undefined;
  let sessionId: string | undefined;
  const cleanupSessions = new Set<string>();

  const step = async <T>(name: string, action: () => Promise<T>): Promise<T> => {
    const stepStarted = now();
    try {
      const result = await action();
      steps.push({ name, status: "passed", durationMs: Math.max(0, now() - stepStarted) });
      return result;
    } catch (error) {
      steps.push({
        name,
        status: "failed",
        durationMs: Math.max(0, now() - stepStarted),
        category: classifySmokeFailure(error),
      });
      throw error;
    }
  };
  const skip = (name: string) => steps.push({ name, status: "skipped", durationMs: 0 });

  try {
    workspace = await step("workspace", async () => {
      await mkdir(options.workspaceRoot, { recursive: true });
      return mkdtemp(resolve(options.workspaceRoot, "agentroam-smoke-"));
    });
    const health = await step("health", async () => {
      const value = await options.adapter.health();
      if (!value.available) throw new Error(`runtime unavailable: ${value.error ?? "health check failed"}`);
      if (!value.version?.trim()) throw new Error("runtime health did not report a version");
      if (options.expectedVersion && !value.version.includes(options.expectedVersion)) {
        throw new Error(`runtime version mismatch: expected ${options.expectedVersion}`);
      }
      return value;
    });
    runtimeVersion = health.version;

    await step("workspace-discovery", async () => {
      await options.adapter.discoverSessions();
      if (options.adapter.listWorkspaces) {
        const page = await options.adapter.listWorkspaces({ limit: 20, refresh: true });
        if (!Array.isArray(page.data)) throw new Error("workspace discovery returned an invalid page");
      }
    });

    const session = await step("create-session", () => options.adapter.create({
      title: "AgentRoam runtime smoke",
      cwd: workspace!,
    }));
    sessionId = session.nativeSessionId;
    cleanupSessions.add(sessionId);

    const proof = `agentroam-smoke-${randomUUID()}`;
    const proofPath = resolve(workspace, "runtime-smoke-proof.txt");
    await step("first-turn-and-tool-permission", async () => {
      const prompt = `Use a shell command to write exactly ${proof} to runtime-smoke-proof.txt in the current workspace, then reply briefly.`;
      const run = await collectRun(options.adapter, sessionId!, prompt, timeoutMs, { permissionMode: "request-approval" });
      if (!run.textSeen) throw new Error("first turn produced no streamed text");
      if (run.terminal !== "done") throw new Error("first turn did not complete successfully");
      if (!run.permissionSeen) throw new Error("first turn did not exercise the permission path");
      const content = await readFile(proofPath, "utf8");
      if (content.trim() !== proof) throw new Error("filesystem tool wrote unexpected proof content");
    });

    await step("first-history-read", async () => {
      const detail = await waitForHistory(options.adapter, sessionId!, 1, options.historyTimeoutMs ?? 30_000);
      requireConversationHistory(detail, 1);
    });

    await step("resume-second-turn", async () => {
      const run = await collectRun(options.adapter, sessionId!, "Reply with a short acknowledgement.", timeoutMs, {
        permissionMode: "request-approval",
      });
      if (!run.textSeen || run.terminal !== "done") throw new Error("resumed turn did not stream and complete");
    });

    await step("second-history-read", async () => {
      const detail = await waitForHistory(options.adapter, sessionId!, 2, options.historyTimeoutMs ?? 30_000);
      requireConversationHistory(detail, 2);
    });

    if (capabilities.goal) {
      await step("goal", async () => {
        const run = await collectRun(options.adapter, sessionId!, "Complete the stated smoke objective and reply briefly.", timeoutMs, {
          permissionMode: "request-approval",
          goal: { id: `smoke-${randomUUID()}`, objective: "Confirm the runtime can complete a bounded goal" },
        });
        if (!run.textSeen || run.terminal !== "done") throw new Error("goal turn did not complete");
      });
    } else skip("goal");

    if (capabilities.fork) {
      await step("fork", async () => {
        if (!options.adapter.fork) throw new Error("fork capability is declared but unavailable");
        const forked = await options.adapter.fork(sessionId!);
        cleanupSessions.add(forked.nativeSessionId);
        if (forked.nativeSessionId === sessionId) throw new Error("fork returned the source session");
      });
    } else skip("fork");

    if (capabilities.archive) {
      await step("archive-fork", async () => {
        if (!options.adapter.archiveSession) throw new Error("archive capability is declared but unavailable");
        const forked = [...cleanupSessions].find((value) => value !== sessionId);
        if (!forked) throw new Error("archive capability requires a forked smoke session");
        await options.adapter.archiveSession(forked);
        cleanupSessions.delete(forked);
      });
    } else skip("archive-fork");

    await step("abort", async () => {
      const runPromise = collectRun(
        options.adapter,
        sessionId!,
        "Use a shell command to wait for 60 seconds before replying.",
        Math.min(timeoutMs, 30_000),
        { permissionMode: "request-approval" },
        { acceptAbort: true },
      );
      await delay(options.abortDelayMs ?? 750);
      if (capabilities.steer) {
        if (!options.adapter.steer) throw new Error("steer capability is declared but unavailable");
        const accepted = await options.adapter.steer(sessionId!, "Continue waiting until interrupted.");
        if (!accepted) throw new Error("runtime rejected steering during an active turn");
      } else skip("steer");
      await options.adapter.abort(sessionId!);
      const run = await runPromise;
      if (run.terminal !== "turn_aborted" && run.terminal !== "interrupted") {
        throw new Error("runtime did not report an aborted turn");
      }
      if (capabilities.steer) steps.push({ name: "steer", status: "passed", durationMs: 0 });
    });

    return {
      schemaVersion: 1,
      agent: options.agent,
      runtimeVersion,
      success: true,
      startedAt,
      durationMs: Math.max(0, now() - started),
      capabilities: steps,
    };
  } catch (error) {
    const category = classifySmokeFailure(error);
    return {
      schemaVersion: 1,
      agent: options.agent,
      runtimeVersion,
      success: false,
      startedAt,
      durationMs: Math.max(0, now() - started),
      capabilities: steps,
      failureCategory: category,
      failure: redactSensitive(errorMessage(error)),
    };
  } finally {
    for (const id of cleanupSessions) {
      if (options.adapter.delete) await options.adapter.delete(id).catch(() => undefined);
      else if (options.adapter.archiveSession) await options.adapter.archiveSession(id).catch(() => undefined);
    }
    await options.adapter.dispose?.().catch(() => undefined);
    if (workspace) await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function collectRun(
  adapter: AgentRuntimeAdapter,
  sessionId: string,
  input: string,
  timeoutMs: number,
  runOptions: Parameters<AgentRuntimeAdapter["run"]>[5],
  options: { acceptAbort?: boolean } = {},
): Promise<CollectedRun> {
  const iterator = adapter.run(sessionId, input, undefined, undefined, undefined, runOptions)[Symbol.asyncIterator]();
  const events: AgentEvent[] = [];
  let textSeen = false;
  let permissionSeen = false;
  try {
    while (true) {
      const next = await withTimeout(iterator.next(), timeoutMs, "runtime event timeout");
      if (next.done) break;
      const event = next.value;
      events.push(event);
      if (event.type === "text_chunk" && event.text.trim()) textSeen = true;
      if (event.type === "done" && event.finalText.trim()) textSeen = true;
      if (event.type === "ask_user") {
        permissionSeen = true;
        const allowed = await adapter.answerQuestion(event.questionId, { answer: "允许一次", selectedIndices: [0] });
        if (!allowed) throw new Error("runtime rejected the smoke permission answer");
      }
      if (event.type === "error") {
        if (options.acceptAbort && /interrupt|abort|cancel/i.test(event.message)) {
          return { events, textSeen, permissionSeen, terminal: "interrupted" };
        }
        throw new Error(`runtime event error: ${event.message}`);
      }
      if (event.type === "turn_aborted") return { events, textSeen, permissionSeen, terminal: "turn_aborted" };
      if (event.type === "done") return { events, textSeen, permissionSeen, terminal: "done" };
    }
    throw new Error("runtime event stream ended without a terminal event");
  } catch (error) {
    await adapter.abort(sessionId).catch(() => undefined);
    throw error;
  } finally {
    const cleanup = iterator.return?.();
    if (cleanup) await withTimeout(cleanup, Math.min(timeoutMs, 1_000), "runtime iterator cleanup timeout").catch(() => undefined);
  }
}

export function classifySmokeFailure(error: unknown): SmokeFailureCategory {
  const message = errorMessage(error).toLowerCase();
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code).toLowerCase() : "";
  if (/\b(401|403)\b|unauth|not logged in|invalid api key|credential|authentication/.test(message)) return "authentication";
  if (/\b429\b|rate.?limit|quota|too many requests/.test(message)) return "rate_limit";
  if (/registry|packument|npm.*(?:404|not found)|eai_again.*npm|enotfound.*npm/.test(message)) return "registry";
  if (/enoent|eacces|runner|executable not found|spawn .* failed/.test(`${message} ${code}`)) return "runner";
  if (/protocol|version mismatch|event timeout|terminal event|history|session|workspace|tool|permission|stream|interrupt|abort/.test(message)) return "compatibility";
  return "unknown";
}

export function redactSensitive(value: string): string {
  return value
    .replace(/\b(?:sk|sk-ant|ghp|github_pat)_[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/((?:api[_ -]?key|token|secret|password)\s*[=:]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

async function waitForHistory(adapter: AgentRuntimeAdapter, sessionId: string, userTurns: number, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  let detail = await adapter.getSession(sessionId);
  while (countRole(detail, "user") < userTurns && Date.now() < deadline) {
    await delay(250);
    detail = await adapter.getSession(sessionId);
  }
  return detail;
}

function requireConversationHistory(detail: UnifiedSessionDetail, userTurns: number) {
  if (countRole(detail, "user") < userTurns) throw new Error(`history is missing user turn ${userTurns}`);
  if (countRole(detail, "assistant") < userTurns) throw new Error(`history is missing assistant turn ${userTurns}`);
}

function countRole(detail: UnifiedSessionDetail, role: "user" | "assistant") {
  return detail.messages.filter((message) => message.role === role).length;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function delay(ms: number) {
  return new Promise<void>((resolveDelay) => setTimeout(resolveDelay, ms));
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export async function main(args = process.argv.slice(2)) {
  const agent = requiredAgent(option(args, "--agent"));
  const workspaceRoot = resolve(option(args, "--workspace"));
  const runtimeHome = resolve(option(args, "--runtime-home"));
  const expectedVersion = optional(args, "--expected-version");
  const executable = optional(args, "--executable");
  await mkdir(runtimeHome, { recursive: true });
  isolateRuntimeEnvironment(runtimeHome);
  if (agent === "opencode") await writeOpenCodeConfig(runtimeHome);
  const adapter = await createAdapter(agent, runtimeHome, executable);
  const summary = await runAgentRuntimeSmoke({
    agent,
    adapter,
    workspaceRoot,
    expectedVersion: agent === "claude" ? undefined : expectedVersion,
  });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (!summary.success) process.exitCode = 1;
  return summary;
}

async function createAdapter(agent: SmokeAgent, runtimeHome: string, executable?: string): Promise<AgentRuntimeAdapter> {
  if (agent === "codex") {
    const { CodexRuntimeAdapter } = await import("../packages/desktop/main/agent-runtime/codex-runtime-adapter.js");
    return new CodexRuntimeAdapter({
      codexExecutable: executable,
      environment: process.env,
      homeDir: runtimeHome,
      sessionRoot: resolve(runtimeHome, "sessions"),
      imageStorageRoot: resolve(runtimeHome, "images"),
    });
  }
  if (agent === "claude") {
    const { ClaudeRuntimeAdapter } = await import("../packages/desktop/main/agent-runtime/claude-runtime-adapter.js");
    return new ClaudeRuntimeAdapter({ sessionRoot: resolve(runtimeHome, "projects") });
  }
  const { OpenCodeRuntimeAdapter } = await import("../packages/desktop/main/agent-runtime/opencode-runtime-adapter.js");
  return new OpenCodeRuntimeAdapter({
    executable,
    environment: process.env,
    dataRoot: resolve(runtimeHome, "opencode"),
  });
}

function isolateRuntimeEnvironment(runtimeHome: string) {
  process.env.HOME = runtimeHome;
  process.env.USERPROFILE = runtimeHome;
  process.env.CODEX_HOME = resolve(runtimeHome, "codex");
  process.env.CLAUDE_CONFIG_DIR = resolve(runtimeHome, "claude");
  process.env.XDG_CONFIG_HOME = resolve(runtimeHome, "xdg-config");
  process.env.XDG_DATA_HOME = resolve(runtimeHome, "xdg-data");
  process.env.XDG_CACHE_HOME = resolve(runtimeHome, "xdg-cache");
}

async function writeOpenCodeConfig(runtimeHome: string) {
  const raw = process.env.AGENTROAM_OPENCODE_CONFIG_JSON;
  if (!raw) throw new Error("AGENTROAM_OPENCODE_CONFIG_JSON is required for isolated OpenCode smoke");
  let normalized;
  try {
    normalized = `${JSON.stringify(JSON.parse(raw), null, 2)}\n`;
  } catch (error) {
    throw new Error(`AGENTROAM_OPENCODE_CONFIG_JSON is invalid JSON: ${errorMessage(error)}`);
  }
  const directory = resolve(runtimeHome, "xdg-config", "opencode");
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, "opencode.json"), normalized, { mode: 0o600 });
}

function option(args: string[], name: string) {
  const value = optional(args, name);
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

function optional(args: string[], name: string) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function requiredAgent(value: string): SmokeAgent {
  if (value === "codex" || value === "claude" || value === "opencode") return value;
  throw new Error(`invalid --agent ${value}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    const summary: SmokeSummary = {
      schemaVersion: 1,
      agent: process.argv.includes("claude") ? "claude" : process.argv.includes("opencode") ? "opencode" : "codex",
      success: false,
      startedAt: new Date().toISOString(),
      durationMs: 0,
      capabilities: [],
      failureCategory: classifySmokeFailure(error),
      failure: redactSensitive(errorMessage(error)),
    };
    process.stderr.write(`${JSON.stringify(summary)}\n`);
    process.exitCode = 1;
  });
}
