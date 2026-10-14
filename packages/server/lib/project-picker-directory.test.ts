import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { projectPickerDirectory } from "./project-picker-directory.mjs";

const temporary: string[] = [];
afterEach(() => temporary.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));

it("starts in the stable AgentRoam installation instead of a versioned runtime", () => {
  const home = mkdtempSync(join(tmpdir(), "agent-picker-install-")); temporary.push(home);
  const installation = join(home, ".agentroam"); mkdirSync(installation);
  expect(projectPickerDirectory(join(installation, "launcher/version/runtime"), {}, home)).toBe(installation);
  expect(projectPickerDirectory("/runtime", { AGENTROAM_DATA_DIR: "/custom/agentroam" }, home)).toBe("/custom/agentroam");
});

it("uses the source runtime directory when AgentRoam has not been installed", () => {
  const home = mkdtempSync(join(tmpdir(), "agent-picker-source-")); temporary.push(home);
  expect(projectPickerDirectory("/checkout/packages/server", {}, home)).toBe("/checkout/packages/server");
});
