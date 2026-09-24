import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

export type ToolPolicyCommandMode = "deny" | "allowlist" | "unrestricted";
export type ToolPolicyNetworkMode = "deny" | "read-only" | "allow";

export interface ToolPolicyProgramRule {
  executable: string;
  subcommands?: string[];
  allowedFlags?: string[];
  deniedFlags?: string[];
  pathFlags?: string[];
  positionalPathIndexes?: number[];
}

export interface ToolExecutionPolicy {
  id: string;
  name: string;
  enabled: boolean;
  allowedTools: string[];
  filesystem: {
    readRoots: string[];
    writeRoots: string[];
    followSymlinks: boolean;
  };
  commands: {
    mode: ToolPolicyCommandMode;
    programs: ToolPolicyProgramRule[];
    inheritedEnvironment: string[];
  };
  network: ToolPolicyNetworkMode;
  limits: {
    timeoutMs: number;
    maxOutputBytes: number;
  };
}

export interface StoredToolExecutionPolicy extends ToolExecutionPolicy {
  created: string;
  updated: string;
}

export interface ToolExecutionPolicySummary {
  id: string;
  name: string;
}

export interface ToolExecutionPolicyStore {
  list(): Promise<StoredToolExecutionPolicy[]>;
  get(id: string): Promise<StoredToolExecutionPolicy | null>;
  save(policy: ToolExecutionPolicy): Promise<StoredToolExecutionPolicy>;
  delete(id: string): Promise<boolean>;
}

export type ToolExecutionPolicyErrorCode =
  | "TOOL_POLICY_NOT_FOUND"
  | "TOOL_POLICY_DISABLED"
  | "TOOL_POLICY_DENIED"
  | "INVALID_TOOL_POLICY";

export class ToolExecutionPolicyError extends Error {
  constructor(
    readonly code: ToolExecutionPolicyErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ToolExecutionPolicyError";
  }
}

export interface ToolExecutionPolicyValidationOptions {
  knownTools?: Iterable<string>;
  requireExecutables?: boolean;
}

const POLICY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const COMMAND_MODES = new Set<ToolPolicyCommandMode>(["deny", "allowlist", "unrestricted"]);
const NETWORK_MODES = new Set<ToolPolicyNetworkMode>(["deny", "read-only", "allow"]);

export function validateToolExecutionPolicy(
  value: unknown,
  options: ToolExecutionPolicyValidationOptions = {},
): ToolExecutionPolicy {
  const input = object(value, "policy");
  const id = text(input.id, "id", 200);
  if (!POLICY_ID.test(id)) invalid("id must use letters, numbers, dot, underscore, or hyphen");
  const name = text(input.name, "name", 200);
  if (typeof input.enabled !== "boolean") invalid("enabled must be boolean");

  const knownTools = options.knownTools ? new Set(options.knownTools) : null;
  const allowedTools = uniqueStrings(input.allowedTools, "allowedTools", 500);
  const unknownTool = knownTools && allowedTools.find((tool) => !knownTools.has(tool));
  if (unknownTool) invalid(`unknown tool: ${unknownTool}`);

  const filesystem = object(input.filesystem, "filesystem");
  const readRoots = roots(filesystem.readRoots, "filesystem.readRoots");
  const writeRoots = roots(filesystem.writeRoots, "filesystem.writeRoots");
  if (typeof filesystem.followSymlinks !== "boolean") {
    invalid("filesystem.followSymlinks must be boolean");
  }

  const commands = object(input.commands, "commands");
  if (typeof commands.mode !== "string" || !COMMAND_MODES.has(commands.mode as ToolPolicyCommandMode)) {
    invalid("commands.mode must be deny, allowlist, or unrestricted");
  }
  const programs = programRules(commands.programs, options.requireExecutables === true);
  if (commands.mode === "allowlist" && programs.length === 0) {
    invalid("commands.programs must not be empty in allowlist mode");
  }
  const inheritedEnvironment = uniqueStrings(
    commands.inheritedEnvironment,
    "commands.inheritedEnvironment",
    200,
  );
  const invalidEnvironment = inheritedEnvironment.find((entry) => !ENVIRONMENT_NAME.test(entry));
  if (invalidEnvironment) invalid(`invalid inherited environment variable: ${invalidEnvironment}`);

  if (typeof input.network !== "string" || !NETWORK_MODES.has(input.network as ToolPolicyNetworkMode)) {
    invalid("network must be deny, read-only, or allow");
  }
  const limits = object(input.limits, "limits");
  const timeoutMs = integer(limits.timeoutMs, "limits.timeoutMs", 100, 600_000);
  const maxOutputBytes = integer(limits.maxOutputBytes, "limits.maxOutputBytes", 1_024, 10_485_760);

  return {
    id,
    name,
    enabled: input.enabled,
    allowedTools,
    filesystem: {
      readRoots,
      writeRoots,
      followSymlinks: filesystem.followSymlinks,
    },
    commands: {
      mode: commands.mode as ToolPolicyCommandMode,
      programs,
      inheritedEnvironment,
    },
    network: input.network as ToolPolicyNetworkMode,
    limits: { timeoutMs, maxOutputBytes },
  };
}

export function toolExecutionPolicySummary(policy: ToolExecutionPolicy): ToolExecutionPolicySummary {
  return { id: policy.id, name: policy.name };
}

function programRules(value: unknown, requireExecutables: boolean): ToolPolicyProgramRule[] {
  if (!Array.isArray(value) || value.length > 200) invalid("commands.programs must be an array with at most 200 entries");
  const seen = new Set<string>();
  return value.map((item, index) => {
    const rule = object(item, `commands.programs[${index}]`);
    const executable = text(rule.executable, `commands.programs[${index}].executable`, 1_024);
    if (executable.includes("\0")) invalid("command executable contains an invalid character");
    if (seen.has(executable)) invalid(`duplicate command executable: ${executable}`);
    seen.add(executable);
    if (requireExecutables && isAbsolute(executable) && !existsSync(executable)) {
      invalid(`command executable does not exist: ${executable}`);
    }
    const subcommands = optionalUniqueStrings(rule.subcommands, `commands.programs[${index}].subcommands`);
    const allowedFlags = optionalUniqueStrings(rule.allowedFlags, `commands.programs[${index}].allowedFlags`);
    const deniedFlags = optionalUniqueStrings(rule.deniedFlags, `commands.programs[${index}].deniedFlags`);
    const pathFlags = optionalUniqueStrings(rule.pathFlags, `commands.programs[${index}].pathFlags`);
    if (allowedFlags && deniedFlags) {
      const contradiction = allowedFlags.find((flag) => deniedFlags.includes(flag));
      if (contradiction) invalid(`flag is both allowed and denied: ${contradiction}`);
    }
    if (pathFlags && allowedFlags) {
      const missing = pathFlags.find((flag) => !allowedFlags.includes(flag));
      if (missing) invalid(`path flag is not allowed: ${missing}`);
    }
    let positionalPathIndexes: number[] | undefined;
    if (rule.positionalPathIndexes !== undefined) {
      if (!Array.isArray(rule.positionalPathIndexes) || rule.positionalPathIndexes.length > 100) {
        invalid(`commands.programs[${index}].positionalPathIndexes must be an array`);
      }
      positionalPathIndexes = [...new Set(rule.positionalPathIndexes.map((entry) => {
        if (!Number.isInteger(entry) || Number(entry) < 0 || Number(entry) > 1_000) {
          invalid(`commands.programs[${index}].positionalPathIndexes contains an invalid index`);
        }
        return Number(entry);
      }))];
    }
    return {
      executable,
      ...(subcommands ? { subcommands } : {}),
      ...(allowedFlags ? { allowedFlags } : {}),
      ...(deniedFlags ? { deniedFlags } : {}),
      ...(pathFlags ? { pathFlags } : {}),
      ...(positionalPathIndexes ? { positionalPathIndexes } : {}),
    };
  });
}

function roots(value: unknown, field: string): string[] {
  const result = uniqueStrings(value, field, 200);
  const invalidRoot = result.find((root) => !isAbsolute(root) || root.includes("\0"));
  if (invalidRoot) invalid(`${field} must contain absolute paths`);
  return result;
}

function optionalUniqueStrings(value: unknown, field: string): string[] | undefined {
  return value === undefined ? undefined : uniqueStrings(value, field, 500);
}

function uniqueStrings(value: unknown, field: string, max: number): string[] {
  if (!Array.isArray(value) || value.length > max) invalid(`${field} must be an array with at most ${max} entries`);
  const result = value.map((entry) => text(entry, field, 1_024));
  if (new Set(result).size !== result.length) invalid(`${field} contains duplicate values`);
  return result;
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    invalid(`${field} must be a non-empty string no longer than ${max} characters`);
  }
  return value.trim();
}

function integer(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    invalid(`${field} must be an integer between ${minimum} and ${maximum}`);
  }
  return Number(value);
}

function invalid(message: string): never {
  throw new ToolExecutionPolicyError("INVALID_TOOL_POLICY", message);
}
