import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { IToolExecutor, ToolContext, ToolResult } from "./entities.js";
import type { ToolExecutionPolicy, ToolPolicyProgramRule } from "./execution-policy.js";
import { writePaths } from "./permissions.js";

const READ_PATH_FIELDS: Record<string, string> = {
  read_file: "file_path",
  grep: "path",
  glob: "path",
};
const WRITE_PATH_FIELDS: Record<string, string> = {
  write_file: "file_path",
  str_replace: "file_path",
};
const NESTED_SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh"]);

export class PolicyAwareToolExecutor implements IToolExecutor {
  private readonly allowedTools: Set<string>;

  constructor(
    private readonly delegate: IToolExecutor,
    private readonly policy: ToolExecutionPolicy,
  ) {
    this.allowedTools = new Set(policy.allowedTools);
  }

  validate(name: string, args: Record<string, unknown>): boolean {
    return this.allowedTools.has(name) && this.delegate.validate(name, args);
  }

  getAuthorizationPolicy(name: string) {
    return this.delegate.getAuthorizationPolicy?.(name) ?? "default";
  }

  getNetworkAccess(name: string) {
    return this.delegate.getNetworkAccess?.(name) ?? "none";
  }

  async execute(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    if (!this.allowedTools.has(name)) return denied("tool is not allowed by the selected policy");

    const network = this.networkDecision(name);
    if (network) return denied(network);

    try {
      if (name === "bash") return await this.executeBash(args, ctx);
      const guardedArgs = await this.guardFilesystem(name, args, ctx);
      return this.delegate.execute(name, guardedArgs, ctx);
    } catch (error) {
      return denied(error instanceof Error ? error.message : "tool request violates the selected policy");
    }
  }

  private networkDecision(name: string): string | null {
    const access = name.startsWith("mcp_")
      ? "unknown"
      : this.getNetworkAccess(name);
    if (access === "none") return null;
    if (this.policy.network === "allow") return null;
    if (this.policy.network === "read-only" && access === "read") return null;
    return this.policy.network === "deny"
      ? "network access is denied by the selected policy"
      : "the tool does not declare read-only network behavior";
  }

  private async guardFilesystem(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<Record<string, unknown>> {
    const readField = READ_PATH_FIELDS[name];
    if (readField) {
      const requested = typeof args[readField] === "string" ? args[readField] as string : ".";
      const path = await resolvePolicyPath(
        requested,
        ctx.workingDirectory,
        this.policy.filesystem.readRoots,
        "read",
        this.policy.filesystem.followSymlinks,
      );
      return { ...args, [readField]: path };
    }
    const writeField = WRITE_PATH_FIELDS[name];
    if (writeField) {
      const requested = typeof args[writeField] === "string" ? args[writeField] as string : "";
      const path = await resolvePolicyPath(
        requested,
        ctx.workingDirectory,
        this.policy.filesystem.writeRoots,
        "write",
        this.policy.filesystem.followSymlinks,
      );
      return { ...args, [writeField]: path };
    }
    if (name === "apply_patch") {
      const paths = writePaths(name, args);
      if (paths.length === 0) throw new Error("the patch does not contain a writable path");
      for (const path of paths) {
        await resolvePolicyPath(
          path,
          ctx.workingDirectory,
          this.policy.filesystem.writeRoots,
          "write",
          this.policy.filesystem.followSymlinks,
        );
      }
    }
    return args;
  }

  private async executeBash(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    if (this.policy.commands.mode === "deny") return denied("command execution is denied by the selected policy");
    if (this.policy.commands.mode === "unrestricted") return this.delegate.execute("bash", args, ctx);
    const command = typeof args.command === "string" ? args.command : "";
    const tokens = parseSimpleCommand(command);
    if (tokens.length === 0) return denied("command must not be empty");
    if (NESTED_SHELLS.has(basename(tokens[0]))) return denied("nested shells are denied by the selected policy");
    const executable = await resolveExecutable(tokens[0]);
    const match = await findProgramRule(executable, this.policy.commands.programs);
    if (!match) return denied("executable is not allowed by the selected policy");
    const commandArgs = await validateCommandArguments(
      tokens.slice(1),
      match,
      ctx.workingDirectory,
      this.policy.filesystem.readRoots,
      this.policy.filesystem.followSymlinks,
    );
    const environment: NodeJS.ProcessEnv = {};
    for (const name of this.policy.commands.inheritedEnvironment) {
      if (process.env[name] !== undefined) environment[name] = process.env[name];
    }
    const requestedTimeout = typeof args.timeout === "number" && Number.isFinite(args.timeout)
      ? Math.max(1, Math.trunc(args.timeout))
      : this.policy.limits.timeoutMs;
    const timeoutMs = Math.min(requestedTimeout, this.policy.limits.timeoutMs);
    return spawnRestricted(executable, commandArgs, {
      cwd: ctx.workingDirectory,
      env: environment,
      timeoutMs,
      maxOutputBytes: this.policy.limits.maxOutputBytes,
      signal: ctx.signal,
    });
  }
}

export async function resolvePolicyPath(
  requested: string,
  workingDirectory: string,
  roots: string[],
  accessMode: "read" | "write",
  followSymlinks: boolean,
): Promise<string> {
  if (!requested || requested.includes("\0")) throw new Error("path is invalid");
  if (roots.length === 0) throw new Error(`${accessMode} access is denied by the selected policy`);
  const target = resolve(workingDirectory, requested);
  const canonicalTarget = accessMode === "read"
    ? await realpath(target).catch(() => { throw new Error("requested read path does not exist"); })
    : await canonicalWriteTarget(target);
  const resolvedRoots = await Promise.all(roots.map(async (root) => {
    if (!isAbsolute(root)) throw new Error("policy root is invalid");
    return {
      configured: resolve(root),
      canonical: await realpath(root).catch(() => { throw new Error("policy root is unavailable"); }),
    };
  }));
  const matchingRoot = resolvedRoots.find((root) => inside(root.canonical, canonicalTarget));
  if (!matchingRoot) {
    throw new Error(`${accessMode} path is outside the allowed roots`);
  }
  if (!followSymlinks) {
    if (!inside(matchingRoot.configured, target)) {
      throw new Error("symbolic link traversal is denied by the selected policy");
    }
    const expectedCanonicalTarget = resolve(
      matchingRoot.canonical,
      relative(matchingRoot.configured, target),
    );
    if (expectedCanonicalTarget !== canonicalTarget) {
      throw new Error("symbolic link traversal is denied by the selected policy");
    }
  }
  return canonicalTarget;
}

export function parseSimpleCommand(command: string): string[] {
  if (!command.trim()) return [];
  if (command.includes("\0") || command.includes("\n") || command.includes("\r")) {
    throw new Error("multi-line commands are denied by the selected policy");
  }
  if (command.includes("$(") || command.includes("`") || command.includes("${")) {
    throw new Error("command substitution is denied by the selected policy");
  }
  const tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;
  let hasToken = false;
  for (const char of command) {
    if (escaping) {
      token += char;
      escaping = false;
      hasToken = true;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      escaping = true;
      hasToken = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else token += char;
      hasToken = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      hasToken = true;
      continue;
    }
    if ("|&;<>".includes(char)) throw new Error("shell operators are denied by the selected policy");
    if (/\s/.test(char)) {
      if (hasToken) {
        tokens.push(token);
        token = "";
        hasToken = false;
      }
      continue;
    }
    token += char;
    hasToken = true;
  }
  if (escaping || quote) throw new Error("command contains an incomplete quote or escape");
  if (hasToken) tokens.push(token);
  if (tokens.some((entry) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(entry))) {
    throw new Error("environment assignments are denied by the selected policy");
  }
  return tokens;
}

async function validateCommandArguments(
  args: string[],
  rule: ToolPolicyProgramRule,
  workingDirectory: string,
  readRoots: string[],
  followSymlinks: boolean,
): Promise<string[]> {
  if (rule.subcommands && !rule.subcommands.includes(args[0] ?? "")) {
    throw new Error("command subcommand is not allowed by the selected policy");
  }
  const allowedFlags = rule.allowedFlags ? new Set(rule.allowedFlags) : null;
  const deniedFlags = new Set(rule.deniedFlags ?? []);
  const pathFlags = new Set(rule.pathFlags ?? []);
  const positionalPathIndexes = new Set(rule.positionalPathIndexes ?? []);
  const result = [...args];
  let positionalIndex = 0;
  for (let index = 0; index < result.length; index++) {
    const value = result[index];
    if (value.startsWith("-") && value !== "-") {
      const separator = value.indexOf("=");
      const flag = separator < 0 ? value : value.slice(0, separator);
      if (deniedFlags.has(flag)) throw new Error("command flag is denied by the selected policy");
      if (allowedFlags && !allowedFlags.has(flag)) throw new Error("command flag is not allowed by the selected policy");
      if (pathFlags.has(flag)) {
        if (separator >= 0) {
          const guarded = await resolvePolicyPath(value.slice(separator + 1), workingDirectory, readRoots, "read", followSymlinks);
          result[index] = `${flag}=${guarded}`;
        } else {
          const pathIndex = index + 1;
          if (!result[pathIndex] || result[pathIndex].startsWith("-")) throw new Error("command path flag requires a value");
          result[pathIndex] = await resolvePolicyPath(result[pathIndex], workingDirectory, readRoots, "read", followSymlinks);
          index++;
        }
      }
      continue;
    }
    if (positionalPathIndexes.has(positionalIndex)) {
      result[index] = await resolvePolicyPath(value, workingDirectory, readRoots, "read", followSymlinks);
    }
    positionalIndex++;
  }
  return result;
}

async function resolveExecutable(executable: string): Promise<string> {
  const candidates = isAbsolute(executable)
    ? [executable]
    : (process.env.PATH ?? "").split(":").filter(Boolean).map((entry) => resolve(entry, executable));
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return await realpath(candidate);
    } catch {
      // Continue searching PATH.
    }
  }
  throw new Error("command executable is unavailable");
}

async function findProgramRule(
  executable: string,
  rules: ToolPolicyProgramRule[],
): Promise<ToolPolicyProgramRule | null> {
  for (const rule of rules) {
    try {
      if (await resolveExecutable(rule.executable) === executable) return rule;
    } catch {
      // An unavailable rule never grants access.
    }
  }
  return null;
}

async function canonicalWriteTarget(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch {
    const missing: string[] = [];
    let current = target;
    while (true) {
      const parent = dirname(current);
      if (parent === current) throw new Error("write path has no existing parent");
      missing.unshift(basename(current));
      current = parent;
      try {
        const canonicalParent = await realpath(current);
        return resolve(canonicalParent, ...missing);
      } catch {
        // Continue until an existing parent is found.
      }
    }
  }
}

function inside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function denied(reason: string): ToolResult {
  return {
    toolCallId: "",
    content: JSON.stringify({
      code: "TOOL_POLICY_DENIED",
      message: reason.replace(/(?:\/[\w.@+-]+){2,}/g, "[local path]"),
    }),
    isError: true,
  };
}

function spawnRestricted(
  executable: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    maxOutputBytes: number;
    signal?: AbortSignal;
  },
): Promise<ToolResult> {
  return new Promise((resolveResult) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let timedOut = false;
    let truncated = false;
    let settled = false;
    const append = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = options.maxOutputBytes - bytes;
      if (remaining > 0) {
        const accepted = buffer.subarray(0, remaining);
        chunks.push(accepted);
        bytes += accepted.length;
      }
      if (buffer.length > remaining) truncated = true;
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const terminate = () => child.kill("SIGTERM");
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, options.timeoutMs);
    timer.unref?.();
    const abort = () => terminate();
    options.signal?.addEventListener("abort", abort, { once: true });
    const finish = (result: ToolResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      resolveResult(result);
    };
    child.once("error", (error) => finish({ toolCallId: "", content: error.message, isError: true }));
    child.once("close", (code, signal) => {
      const output = Buffer.concat(chunks).toString("utf8") || "(no output)";
      const suffix = truncated ? "\n[output truncated by tool policy]" : "";
      if (timedOut) {
        finish({ toolCallId: "", content: `${output}${suffix}\nCommand timed out`, isError: true });
      } else if (options.signal?.aborted) {
        finish({ toolCallId: "", content: "Command aborted", isError: true });
      } else if (code !== 0) {
        finish({ toolCallId: "", content: `${output}${suffix}\nProcess exited with ${code ?? signal ?? "unknown"}`, isError: true });
      } else {
        finish({ toolCallId: "", content: `${output}${suffix}` });
      }
    });
  });
}
