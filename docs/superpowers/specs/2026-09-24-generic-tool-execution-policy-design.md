# Generic Tool Execution Policy Design

## Status

Approved architecture direction. Written specification pending final review before implementation.

## Problem

Customer Agent currently limits a run to a list of tool names, but the selected tool still receives its full built-in authority. In particular:

- `bash` executes an arbitrary command string through `exec()`.
- `read_file`, `grep`, and `glob` accept absolute paths and can leave the working directory.
- the existing permission modes decide whether to ask for approval, but do not express a durable per-run capability boundary.
- an unattended Flow run cannot depend on an interactive approval prompt.

A Flow must be able to select a reusable Customer Agent tool policy without Customer Agent containing branches for a specific Flow, Agent, Skill, homepage, or Wiki.

## Goal

Add a generic policy layer to Customer Agent tool execution. Every tool call is evaluated against the effective run policy before reaching the tool implementation.

The same policy mechanism must work for WebApp, desktop, SDK, and Flow protocol callers. Flow Studio only selects a stored policy by ID. It does not send executable policy definitions and Customer Agent does not infer policy from Flow IDs, Agent IDs, Skill names, prompts, or tool arguments.

## Non-Goals

- Implementing QMD, GraphRAG, homepage rendering, or any other business capability in Customer Agent.
- Creating a Wiki-specific tool in Customer Agent.
- Adding conditional code for `homepage-agent`, `homepage-main`, `wiki-query`, or `wiki_query`.
- Treating prompt instructions as an enforcement boundary.
- Replacing the existing tool allowlist, Agent capability selection, or interactive permission modes.

## Selected Design

Customer Agent stores named `ToolExecutionPolicy` profiles. A run may reference one profile with `toolPolicyId`. The execution boundary is the intersection of:

1. tools enabled on the selected Agent;
2. tools requested for the run;
3. tools permitted by the selected policy;
4. Customer Agent's global tool safety ceiling.

The policy is enforced by a generic executor wrapper in `@agent/core`. Tool implementations remain unaware of Flow Studio and business use cases.

## Considered Approaches

### Hard-code a restricted Wiki tool

This hides shell access but couples Customer Agent to one Skill and one data source. It duplicates logic already described by the Skill and cannot be reused by other Agents. Rejected.

### Let Flow send an inline allowlist

This is flexible, but makes the caller the authority that defines its own sandbox. A compromised or misconfigured caller could widen its permissions. Rejected.

### Store generic policies in Customer Agent and let callers select one

This is the selected approach. Customer Agent owns and validates the enforcement rule. Trusted callers select an existing policy ID but cannot redefine it. The mechanism is reusable and contains no Flow-specific conditionals.

## Domain Contract

```ts
interface ToolExecutionPolicy {
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
    mode: "deny" | "allowlist" | "unrestricted";
    programs: Array<{
      executable: string;
      subcommands?: string[];
      allowedFlags?: string[];
      deniedFlags?: string[];
      pathFlags?: string[];
      positionalPathIndexes?: number[];
    }>;
    inheritedEnvironment: string[];
  };
  network: "deny" | "read-only" | "allow";
  limits: {
    timeoutMs: number;
    maxOutputBytes: number;
  };
}

interface AgentRunCapabilitySelection {
  enabledTools?: string[];
  enabledSkills?: string[];
  activatedSkills?: string[];
  enabledMCPServers?: string[];
  memoryEnabled?: boolean;
  toolPolicyId?: string;
}
```

An absent `toolPolicyId` preserves existing behavior for compatibility. A supplied ID must resolve to an enabled stored policy before the run is admitted. Unknown and disabled policies fail before Session creation.

## Storage And Catalog

Tool policies are first-class Customer Agent configuration records with their own store and CRUD service. They are not embedded in Agent definitions or Flow snapshots.

The Flow catalog adds summaries only:

```json
{
  "toolPolicies": [
    { "id": "wiki-readonly", "name": "Wiki read-only" }
  ]
}
```

Policy details remain server-side. Flow Studio saves only the selected `toolPolicyId` with the external Agent configuration and sends it in the run selection.

## Enforcement Pipeline

```text
model tool call
  -> exact tool-name allowlist
  -> stored ToolExecutionPolicy
  -> existing permission gate
  -> tool implementation
  -> normalized tool event
```

Policy denial is deterministic and cannot be overridden by an approval response. The existing permission gate runs after policy enforcement and may impose additional approval requirements; it can never widen the policy.

Denials return a normal tool result with a stable code and a public reason. The model may continue with another permitted approach. The full denial record is retained in execution events.

## Filesystem Enforcement

Path-bearing tools are checked by a shared path guard before execution.

- Relative paths resolve against the run working directory.
- Existing targets are canonicalized with `realpath`.
- A target must remain inside one configured read or write root.
- Symlink traversal outside a root is denied.
- `read_file`, `grep`, and `glob` require a read root.
- `write_file`, `str_replace`, and `apply_patch` require a write root.
- A policy with an empty `writeRoots` list denies every filesystem write.

The guard is generic and driven only by the selected policy.

## Command Enforcement

Restricted command execution cannot rely on regular-expression blacklists around the current `exec()` implementation.

For `commands.mode = "allowlist"`:

1. parse the command into a single simple command;
2. reject pipes, redirects, command substitution, background execution, shell control operators, environment assignments, and nested shells;
3. resolve the executable to a canonical path;
4. require an exact allowed executable and optional allowed subcommand;
5. validate flags against the program rule and path-bearing arguments through the same filesystem guard;
6. construct a minimal environment from `inheritedEnvironment` rather than inheriting every server variable;
7. execute with `spawn(executable, args, { shell: false })`;
8. enforce timeout and output limits.

For compatibility, unrestricted runs retain the existing Bash behavior when no restrictive policy is selected. Restricted policy execution never reaches `exec()`.

The policy model does not contain QMD or GraphRAG concepts. An administrator may configure a profile that allows selected `qmd` and `obsidian-wiki` read commands, but those executable names remain configuration data.

## Network Enforcement

- `deny` rejects network tools and MCP tools before execution.
- `read-only` permits only tools whose registered authorization policy declares read-only network behavior.
- `allow` delegates to the existing permission gate.

Unknown dynamic or MCP tools fail closed under a restrictive policy unless the policy explicitly lists them and their registered authorization metadata is compatible.

## Flow Protocol

`POST /api/flow/v1/runs` accepts `selection.toolPolicyId`. Validation resolves the policy through the same application-layer catalog used by other run adapters.

The route continues to pass model, Skill, tool, MCP, memory, and policy selections into `StartAgentRunUseCase`. No route or runtime code switches on Flow ID, Agent ID, Skill name, or input text.

The normalized event stream remains generic. Tool denials, starts, completions, and failures are observable without adding homepage-specific event types.

## UI

Customer Agent gains a generic Tool Policies settings surface:

- list, create, edit, disable, and delete named policies;
- select allowed tools;
- configure read and write roots;
- configure command mode, executables, and subcommands;
- configure network mode, timeout, and output limit;
- validate duplicate IDs, invalid roots, missing executables, and contradictory settings before save.

Flow Studio pulls policy summaries from the existing Customer Agent catalog endpoint and stores the selected ID in an external Agent configuration. It does not edit Customer Agent policies.

## Error Contract

- `404 TOOL_POLICY_NOT_FOUND`: the selected policy does not exist.
- `422 TOOL_POLICY_DISABLED`: the policy exists but is disabled.
- `422 TOOL_POLICY_DENIED`: a tool call violates the effective policy.
- `422 INVALID_TOOL_POLICY`: a policy cannot be saved because its structure is invalid.

Run-admission errors do not create a Session. Per-call denials are persisted as tool events and do not expose local secrets or unrestricted absolute paths to public callers.

## Migration

1. Add the policy domain types, validation, store, and CRUD service.
2. Add generic policy enforcement around the core tool executor.
3. Add filesystem and restricted-command guards with focused tests.
4. Extend `StartAgentRunUseCase` and all run adapters with optional `toolPolicyId`.
5. Extend the Flow catalog and run protocol with policy summaries and selection.
6. Add the Customer Agent settings UI.
7. Add Flow Studio policy discovery and selection.
8. Configure a reusable read-only policy for the desired local commands through the UI.
9. Remove the existing portfolio/Wiki-specific tools and registration paths from Customer Agent after the Flow configuration has migrated.

## Verification

- Unit tests prove capability intersection, unknown/disabled policy rejection, path traversal and symlink rejection, write denial, shell operator rejection, executable/subcommand allowlisting, timeout, and output truncation.
- Application tests prove every run adapter passes the same policy selection into the shared use case.
- Flow protocol tests prove the catalog returns policy summaries and run admission rejects invalid policy IDs.
- Integration tests prove a configured read-only policy can execute allowed read commands while write, network, and unrelated commands fail.
- Regression tests prove runs without `toolPolicyId` retain their existing behavior.
- Source scans prove the generic policy implementation contains no homepage, portfolio, Wiki, QMD, GraphRAG, Agent ID, or Flow ID branches.

## Security Invariants

1. A caller selects a stored policy but cannot define or widen it in the run request.
2. Policy enforcement runs before interactive approval and cannot be bypassed by approval mode.
3. Tool name selection never grants more authority than the selected policy.
4. Canonical filesystem checks prevent `..` and symlink escapes.
5. Restricted command mode never invokes a shell.
6. Unknown tools fail closed under restrictive policies.
7. Secrets and full local paths are redacted from public events.
8. No implementation branch depends on a particular Flow, Agent, Skill, or business domain.
