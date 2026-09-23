import type { SkillDefinition } from "@agent/core";

export const COMPUTER_USE_SKILL_NAME = "computer-use";

const prompt = `Use the computer tool to operate the current macOS desktop when the user explicitly invokes this Skill, or when a required GUI interaction is blocking the task.

Workflow:
1. Prefer file, shell, API, and purpose-built browser tools when they can complete the work. Do not use desktop control merely for convenience.
2. Call computer with action=observe before acting. Prefer revision-bound Accessibility node actions over coordinates.
3. Make exactly one desktop action per computer call.
4. After an action that can change visible state, observe again before deciding the next action.
5. If Accessibility coverage is partial and the target is absent, call action=screenshot and use coordinates from that current screenshot only.
6. If the tool reports stale_observation, observe again and use the new revision. Never reuse an old nodeId with a newer revision.
7. Stop on desktop_locked, accessibility_denied, screen_recording_denied, desktop_controlled_by_user, or desktop_offline. Explain the required recovery and do not claim the action succeeded.

If no computer tool is available, say that Customer Agent desktop control is unavailable in this run. Do not simulate tool calls or describe an operation as completed without a successful observation after the change.`;

export const COMPUTER_USE_SKILL: SkillDefinition = Object.freeze({
  name: COMPUTER_USE_SKILL_NAME,
  description: "Operate the current macOS desktop through Customer Agent's built-in computer tool. Use when the user explicitly asks to click, type, scroll, open System Settings, or operate a desktop app, and when a required GUI interaction cannot be completed with a purpose-built tool.",
  triggers: [
    "computer-use",
    "操作电脑",
    "操作桌面",
    "打开系统设置",
    "点击桌面",
  ],
  filePath: "builtin://customer-agent/computer-use",
  source: "custom",
  prompt,
});
