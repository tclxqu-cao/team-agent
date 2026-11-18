import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeTodoContext } from "@agent/native-runtime";

const fixture = vi.hoisted(() => ({ baseDir: "", ownerId: "owner-1", db: undefined as unknown as Database.Database }));
vi.mock("./todo-service", () => ({ todoServices: () => ({ db: fixture.db }) }));
vi.mock("../server-data-dir", () => ({ getServerBaseDir: () => fixture.baseDir }));
vi.mock("../web-auth/anonymous", () => ({ anonymousPrincipal: () => ({ userId: fixture.ownerId }) }));

import { authenticateTodoCredential, issueTodoCredential } from "./todo-mcp-credentials";
import { createRuntimeTodoContext, readRuntimeTodoContext, storedRuntimeTodoContext } from "./runtime-todo-context";

const roots: string[] = [];
const key = (sessionId: string) => `todo.session.${createHash("sha256").update(sessionId).digest("hex")}`;
const put = (sessionId: string, context: RuntimeTodoContext) => fixture.db.prepare("INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)").run(key(sessionId), JSON.stringify(context));
const credential = (path: string) => authenticateTodoCredential(JSON.parse(readFileSync(path, "utf8")).token);
const credentialCount = () => (fixture.db.prepare("SELECT count(*) AS n FROM settings WHERE key LIKE 'todo.credential.%'").get() as { n: number }).n;
function temporaryRoot() { const root = mkdtempSync(join(tmpdir(), "todo-context-host-")); roots.push(root); return root; }

beforeEach(() => {
  fixture.baseDir = temporaryRoot(); fixture.ownerId = "owner-1";
  fixture.db = new Database(":memory:");
  fixture.db.exec("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
  fixture.db.prepare("INSERT INTO settings(key,value) VALUES('todo.serviceId',?)").run(JSON.stringify("service-1"));
  vi.stubEnv("AGENTROAM_DISCOVERY_DIR", join(fixture.baseDir, "service-discovery"));
});
afterEach(() => { fixture.db.close(); vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("portable runtime Todo context", () => {
  it("binds a seed to this session and reuses valid local descriptors", () => {
    const seed = createRuntimeTodoContext();
    const first = storedRuntimeTodoContext("session-1", seed), count = credentialCount();
    expect(first.descriptorPath).toBe(seed.descriptorPath);
    expect(credential(first.descriptorPath)).toMatchObject({ serviceId: "service-1", ownerId: "owner-1", scope: "manage", sessionId: "session-1" });
    expect(credential(first.relayPath!)).toMatchObject({ scope: "relay", sessionId: "session-1" });
    expect(storedRuntimeTodoContext("session-1")).toEqual(first);
    expect(credentialCount()).toBe(count);
  });

  it("reissues current-host descriptors for a copied Windows context without guessing old paths", () => {
    const old: RuntimeTodoContext = { serviceId: "service-1", ownerId: "owner-1", descriptorPath: "C:\\Users\\Different Person\\AgentRoam\\credential.json", relayPath: "C:\\Users\\Different Person\\AgentRoam\\relay.json", discoveryDirectory: "C:\\Users\\Different Person\\services", executionId: "execution-1", model: "selected-model" };
    put("scheduled-session", old);
    const migrated = storedRuntimeTodoContext("scheduled-session");
    expect(dirname(migrated.descriptorPath)).toBe(join(fixture.baseDir, ".agent-data", "todo-credentials"));
    expect(migrated.discoveryDirectory).toBe(join(fixture.baseDir, "service-discovery"));
    expect(migrated).toMatchObject({ serviceId: old.serviceId, ownerId: old.ownerId, executionId: old.executionId, model: old.model });
    expect(credential(migrated.descriptorPath)).toMatchObject({ scope: "execution", executionId: "execution-1", sessionId: "scheduled-session" });
    expect(credential(migrated.relayPath!)).toMatchObject({ scope: "relay", executionId: "execution-1" });
    expect(readRuntimeTodoContext("scheduled-session")).toEqual(migrated);
  });

  it("does not reuse the old data root even when its descriptor still exists on this computer", () => {
    const old = storedRuntimeTodoContext("session-1");
    const oldCredential = readFileSync(old.descriptorPath, "utf8");
    fixture.baseDir = temporaryRoot();
    vi.stubEnv("AGENTROAM_DISCOVERY_DIR", join(fixture.baseDir, "new-discovery"));
    const migrated = storedRuntimeTodoContext("session-1");
    expect(migrated.descriptorPath).not.toBe(old.descriptorPath);
    expect(dirname(migrated.descriptorPath)).toBe(join(fixture.baseDir, ".agent-data", "todo-credentials"));
    expect(credential(migrated.descriptorPath)).toMatchObject({ ownerId: "owner-1", serviceId: "service-1", scope: "manage" });
    expect(readFileSync(old.descriptorPath, "utf8")).toBe(oldCredential);
  });

  it("reissues an unauthenticated copied credential and updates a changed local registry", () => {
    const old = storedRuntimeTodoContext("session-1");
    fixture.db.prepare("DELETE FROM settings WHERE key LIKE 'todo.credential.%'").run();
    const renewed = storedRuntimeTodoContext("session-1");
    expect(renewed.descriptorPath).not.toBe(old.descriptorPath);
    const count = credentialCount();
    vi.stubEnv("AGENTROAM_DISCOVERY_DIR", join(fixture.baseDir, "registry-after-move"));
    const updated = storedRuntimeTodoContext("session-1");
    expect(updated.descriptorPath).toBe(renewed.descriptorPath);
    expect(updated.discoveryDirectory).toBe(join(fixture.baseDir, "registry-after-move"));
    expect(credentialCount()).toBe(count);
  });

  it("rejects another stored owner or service instead of silently changing identity", () => {
    for (const mismatch of [{ ownerId: "other-owner" }, { serviceId: "other-service" }]) {
      const context = { serviceId: "service-1", ownerId: "owner-1", descriptorPath: "/missing/copied-credential", ...mismatch };
      put("session-1", context);
      expect(() => storedRuntimeTodoContext("session-1")).toThrow("不属于当前服务和用户");
      expect(readRuntimeTodoContext("session-1")).toEqual(context);
      expect(credentialCount()).toBe(0);
    }
  });

  it("rejects a valid credential from another owner, session or execution scope", () => {
    const otherOwner = issueTodoCredential({ ownerId: "other-owner", scope: "manage", sessionId: "session-1" });
    const otherSession = issueTodoCredential({ ownerId: "owner-1", scope: "manage", sessionId: "another-session" });
    const execution = issueTodoCredential({ ownerId: "owner-1", scope: "execution", sessionId: "session-1", executionId: "execution-1" });
    const count = credentialCount();
    for (const descriptorPath of [otherOwner.path, otherSession.path, execution.path]) {
      const context = { serviceId: "service-1", ownerId: "owner-1", descriptorPath };
      expect(() => storedRuntimeTodoContext("session-1", context)).toThrow("用户、权限或会话身份不匹配");
      expect(readRuntimeTodoContext("session-1")).toBeUndefined();
      expect(credentialCount()).toBe(count);
    }
  });
});
