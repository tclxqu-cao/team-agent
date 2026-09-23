# Customer Agent Computer Use Skill Design

## Goal

Expose the existing macOS `computer` model tool as a first-class Customer Agent Skill that users can activate from the desktop composer with `/computer-use <task>`.

## Scope

- The first version is available only to Customer Agent.
- Codex, Claude Code, and OpenCode keep their existing computer-use implementations and receive no imports or registrations from this feature.
- The existing `computer` tool contract remains unchanged: one action per call, Accessibility observation first, screenshot fallback, and direct Customer Agent authorization without bypassing macOS TCC.
- The Skill remains visible and loadable when the desktop relay is offline so the model can report that GUI control is unavailable. The `computer` tool itself is registered only when the relay is compatible.

## Architecture

`@agent/computer-use` owns an immutable `SkillDefinition` containing the Skill metadata and prompt. It does not register itself or grant tool access. The Customer Agent Server composition root registers the Skill and independently attempts to register the `computer` tool.

The desktop Skill catalog merges this built-in definition with discovered and stored skills, so the slash picker is independent of the current working directory. The generic AgentLoop recognizes only a slash command at the beginning of the current user message and attempts to load the exact matching Skill. Unknown or disallowed names are ignored; explicitly activated trusted-caller skills keep their existing fail-fast behavior.

## Invocation

For input such as:

```text
/computer-use 打开系统设置并进入声音
```

the run performs these steps:

1. Preserve the complete input as the user message and session history text.
2. Extract the exact leading Skill name `computer-use`.
3. Load it through the Skill registry with the current `enabledSkills` policy.
4. Inject its prompt before the first model request, without semantic matching or a second model request.
5. Expose `computer` only if the compatible Electron relay registered it.

Natural-language requests do not preload the Skill. The model may still find it through `skill_discover` and load it through `skill_load`.

## Skill Contract

The Skill directs the model to:

- Use `computer` when `/computer-use` explicitly requests desktop operation, or when a GUI interaction is genuinely required to continue.
- Prefer file, shell, API, or purpose-built browser tools for work those tools can complete.
- Call `observe` first and prefer revision-bound Accessibility node actions.
- Use `screenshot` only when Accessibility data is unavailable or does not contain the target.
- Perform one action per tool call and observe again after a state-changing action before deciding the next action.
- Re-observe after `stale_observation` and stop on lock, permission, relay, or desktop-ownership failures instead of claiming success.
- Report tool unavailability directly when no `computer` tool is exposed.

## Error Handling

- Unknown leading slash command: do not inject a Skill and do not fail the run.
- Skill excluded by `enabledSkills`: do not inject it and do not fail the run.
- Trusted caller supplies an unavailable `activatedSkills` entry: preserve the existing error.
- Relay offline or incompatible: load the Skill, omit `computer`, and let the model explain the unavailable capability.
- macOS TCC denial or locked desktop: surface the tool error and required recovery; do not retry mutations blindly.

## Verification

Focused tests must prove:

- the built-in definition contains the `computer` workflow and exports from `@agent/computer-use`;
- `/computer-use ...` injects exactly one Skill prompt while preserving the original input;
- ordinary natural-language input, unknown slash commands, and disallowed Skills do not preload a prompt;
- an already activated Skill is not injected twice;
- Server Skill listing includes `computer-use` independent of the working directory;
- Customer Agent registers the Skill even when relay probing fails, while tool registration remains conditional.
