import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TodoError } from "@agent/core";
import { todoServices } from "./todo-service";
import { getServerBaseDir } from "../server-data-dir";
export interface TodoCredential { serviceId: string; ownerId: string; scope: "manage" | "execution" | "relay"; sessionId?: string; executionId?: string; expiresAt: number; revoked?: boolean }
export function todoServiceId(): string {
  const row = todoServices().db.prepare("SELECT value FROM settings WHERE key='todo.serviceId'").get() as { value: string } | undefined;
  if (!row) throw new TodoError("UNAVAILABLE", "服务身份尚未初始化");
  return JSON.parse(row.value);
}
const key = (token: string) => `todo.credential.${createHash("sha256").update(token).digest("hex")}`;
export function issueTodoCredential(input: Omit<TodoCredential, "serviceId" | "expiresAt">) {
  const token = randomBytes(32).toString("hex");
  const credential: TodoCredential = { ...input, serviceId: todoServiceId(), expiresAt: Date.now() + 366 * 86400000 };
  todoServices().db.prepare("INSERT INTO settings(key,value) VALUES(?,?)").run(key(token), JSON.stringify(credential));
  const directory = join(getServerBaseDir(), ".agent-data", "todo-credentials");
  mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
  const path = join(directory, `${randomUUID()}.json`);
  writeFileSync(path, JSON.stringify({ serviceId: credential.serviceId, token, scope: credential.scope, discoveryDirectory: process.env.AGENTROAM_DISCOVERY_DIR }), { mode: 0o600 });
  return { path, credential };
}
export function authenticateTodoCredential(token: string | null): TodoCredential {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new TodoError("FORBIDDEN", "MCP 凭据无效");
  const row = todoServices().db.prepare("SELECT value FROM settings WHERE key=?").get(key(token)) as { value: string } | undefined;
  const c = row ? JSON.parse(row.value) as TodoCredential : undefined;
  if (!c || c.revoked || c.expiresAt <= Date.now() || c.serviceId !== todoServiceId()) throw new TodoError("FORBIDDEN", "MCP 凭据失效");
  return c;
}
export function revokeTodoCredential(token: string): void {
  todoServices().db.prepare("DELETE FROM settings WHERE key=?").run(key(token));
}
export function bindTodoCredentialSession(descriptorPath: string, sessionId: string): void {
  const { token } = JSON.parse(readFileSync(descriptorPath, "utf8"));
  const credential = authenticateTodoCredential(token);
  if (credential.sessionId && credential.sessionId !== sessionId) throw new TodoError("FORBIDDEN", "MCP 凭据已绑定其他会话");
  if (!credential.sessionId) todoServices().db.prepare("UPDATE settings SET value=? WHERE key=?").run(JSON.stringify({ ...credential, sessionId }), key(token));
}
