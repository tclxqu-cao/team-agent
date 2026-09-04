#!/usr/bin/env node
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseNameStatus, validateRuntimeDiff } from "./agent-runtime-diff-policy.mjs";

const execFileAsync = promisify(execFile);
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

export async function main(args = process.argv.slice(2), options = {}) {
  const agent = option(args, "--agent");
  const base = validateRef(option(args, "--base"), "base");
  const head = validateRef(option(args, "--head"), "head");
  const repositoryRoot = optional(args, "--root") ? resolve(optional(args, "--root")) : root;
  const run = options.run ?? ((gitArgs) => runGit(gitArgs, repositoryRoot));
  const nameStatus = await run(["diff", "--name-status", "--no-renames", base, head, "--"]);
  const changes = parseNameStatus(nameStatus);
  for (const change of changes) {
    if (change.path) change.mode = await fileMode(run, head, change.path);
  }
  const packageDiffs = [];
  for (const change of changes) {
    if (!change.path?.endsWith("package.json") || change.status === "D") continue;
    packageDiffs.push({
      path: change.path,
      before: change.status === "A" ? null : await run(["show", `${base}:${change.path}`]),
      after: await run(["show", `${head}:${change.path}`]),
    });
  }
  const result = validateRuntimeDiff({ agent, changes, packageDiffs });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) throw new Error(`missing ${name}`);
  return args[index + 1];
}

function optional(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function validateRef(value, label) {
  if (value.startsWith("-") || value.includes(":")) throw new Error(`invalid ${label} ref`);
  return value;
}

async function fileMode(run, ref, path) {
  const output = await run(["ls-tree", ref, "--", path]);
  return output.match(/^(\d{6})\s/)?.[1];
}

async function runGit(args, cwd) {
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
