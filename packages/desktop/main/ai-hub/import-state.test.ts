import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  IMPORT_STATE_SCHEMA_VERSION,
  ProfileImportStateStore,
  normalizeProfileImportState,
} from "./import-state";

const validState = {
  schemaVersion: IMPORT_STATE_SCHEMA_VERSION,
  sourceId: "chrome-default",
  completedAt: "2026-09-10T03:00:00.000Z",
  destinationPath: "/tmp/userData/ai-hub-browser-profile/current",
  copiedBytes: 1024,
  importedCookieCount: 12,
  skippedCookieCount: 3,
  restartRequired: true,
};

describe("normalizeProfileImportState", () => {
  it("round-trips a valid state unchanged", () => {
    expect(normalizeProfileImportState(validState)).toEqual(validState);
  });

  it("rejects garbage, wrong schema versions, and negative counters", () => {
    expect(normalizeProfileImportState(null)).toBeNull();
    expect(normalizeProfileImportState("nope")).toBeNull();
    expect(normalizeProfileImportState({})).toBeNull();
    expect(normalizeProfileImportState({ ...validState, schemaVersion: 99 })).toBeNull();
    expect(normalizeProfileImportState({ ...validState, importedCookieCount: -1 })).toBeNull();
    expect(normalizeProfileImportState({ ...validState, destinationPath: "" })).toBeNull();
  });

  it("keeps sanitized error categories and drops unknown ones", () => {
    expect(normalizeProfileImportState({ ...validState, lastErrorCategory: "keychain-denied" })?.lastErrorCategory)
      .toBe("keychain-denied");
    expect(normalizeProfileImportState({ ...validState, lastErrorCategory: "totally-bogus" })?.lastErrorCategory)
      .toBeUndefined();
  });
});

describe("ProfileImportStateStore", () => {
  it("returns null when no import has happened", () => {
    const store = new ProfileImportStateStore(join(mkdtempSync(join(tmpdir(), "hub-state-")), "state.json"));
    expect(store.load()).toBeNull();
  });

  it("saves and loads atomically", () => {
    const store = new ProfileImportStateStore(join(mkdtempSync(join(tmpdir(), "hub-state-")), "state.json"));
    store.save(validState);
    expect(store.load()).toEqual(validState);
  });

  it("treats a corrupted file as no-import instead of throwing", () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-state-"));
    const path = join(dir, "state.json");
    const store = new ProfileImportStateStore(path);
    store.save(validState);
    writeFileSync(path, "{broken json", "utf8");
    expect(store.load()).toBeNull();
  });
});
