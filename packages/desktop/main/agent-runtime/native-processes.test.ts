import { describe, expect, it } from "vitest";
import { selectOpenSessionFiles } from "./native-processes.js";

const ROOT = "/tmp/sessions";
const OLD_SESSION = `${ROOT}/old.jsonl`;
const RECENT_SESSION = `${ROOT}/recent.jsonl`;

function lsofOutput(): string {
  return [
    "p123",
    `n${OLD_SESSION}`,
    "p456",
    `n${RECENT_SESSION}`,
  ].join("\n");
}

describe("selectOpenSessionFiles", () => {
  it("keeps old files occupied when idle expiry is disabled", () => {
    const selected = selectOpenSessionFiles(lsofOutput(), ROOT, {
      idleAfterMs: null,
      nowMs: 1_000_000,
      getMtimeMs: () => 0,
    });

    expect(selected).toEqual(new Set([OLD_SESSION, RECENT_SESSION]));
  });

  it("drops quiet files under the default idle policy", () => {
    const selected = selectOpenSessionFiles(lsofOutput(), ROOT, {
      idleAfterMs: 120_000,
      nowMs: 1_000_000,
      getMtimeMs: (file) => file === OLD_SESSION ? 0 : 950_000,
    });

    expect(selected).toEqual(new Set([RECENT_SESSION]));
  });

  it("excludes files held by the current app-server process", () => {
    const selected = selectOpenSessionFiles(lsofOutput(), ROOT, {
      excludePids: [123],
      idleAfterMs: null,
      getMtimeMs: () => 0,
    });

    expect(selected).toEqual(new Set([RECENT_SESSION]));
  });

  it("ignores files that disappear before metadata inspection", () => {
    const selected = selectOpenSessionFiles(lsofOutput(), ROOT, {
      idleAfterMs: null,
      getMtimeMs: () => { throw new Error("gone"); },
    });

    expect(selected).toEqual(new Set());
  });
});
