import { describe, expect, it } from "vitest";
import {
  AUTO_TITLE_PENDING_METADATA_KEY,
  consumePendingAutoTitle,
  NEW_SESSION_PLACEHOLDER_TITLE,
  withPendingAutoTitle,
} from "./SessionTitle.js";

describe("session auto title", () => {
  it("marks only the exact placeholder title", () => {
    expect(withPendingAutoTitle(NEW_SESSION_PLACEHOLDER_TITLE, { permissionMode: "full-access" })).toEqual({
      permissionMode: "full-access",
      [AUTO_TITLE_PENDING_METADATA_KEY]: true,
    });
    expect(withPendingAutoTitle("Explicit title", { permissionMode: "full-access" })).toEqual({
      permissionMode: "full-access",
    });
  });

  it("consumes the first non-empty input once and truncates it to 60 characters", () => {
    const result = consumePendingAutoTitle({
      metadata: { permissionMode: "full-access", [AUTO_TITLE_PENDING_METADATA_KEY]: true },
    }, "x".repeat(61));

    expect(result).toEqual({ title: "x".repeat(60), metadata: { permissionMode: "full-access" } });
    expect(consumePendingAutoTitle({ metadata: result?.metadata ?? {} }, "later")).toBeNull();
  });

  it("preserves the marker for blank input and ignores historical unmarked sessions", () => {
    const marked = { metadata: { [AUTO_TITLE_PENDING_METADATA_KEY]: true } };
    expect(consumePendingAutoTitle(marked, "   ")).toBeNull();
    expect(marked.metadata[AUTO_TITLE_PENDING_METADATA_KEY]).toBe(true);
    expect(consumePendingAutoTitle({ metadata: {} }, "first message")).toBeNull();
  });
});
