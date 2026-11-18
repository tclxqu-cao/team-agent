import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import type { RuntimeTodoContext } from "@agent/native-runtime";
import { TodoError } from "@agent/core";
import { issueTodoCredential, bindTodoCredentialSession, authenticateTodoCredential, todoServiceId } from "./todo-mcp-credentials";
import { todoServices } from "./todo-service";
import { anonymousPrincipal } from "../web-auth/anonymous";
import { getServerBaseDir } from "../server-data-dir";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

const discoveryDirectory = () => process.env.AGENTROAM_DISCOVERY_DIR ?? join(homedir(), ".agentroam", "services");

function assertCurrentIdentity(context: RuntimeTodoContext): void {
  if (context.serviceId !== todoServiceId() || context.ownerId !== anonymousPrincipal().userId) {
    throw new TodoError("FORBIDDEN", "待办会话不属于当前服务和用户，拒绝迁移凭据");
  }
  if (context.executionId !== undefined && (typeof context.executionId !== "string" || !context.executionId)) {
    throw new TodoError("INVALID_ARGUMENT", "待办执行身份无效");
  }
}

/** A copied absolute path is never a credential locator on a different host.
 * Only current data-root descriptors may be reused, after authenticating their
 * owner, scope, execution and session against this service's credential store. */
function currentDescriptor(path: string | undefined, scope: "manage" | "execution" | "relay", context: RuntimeTodoContext, sessionId: string): boolean {
  let token: unknown;
  let declaredScope: unknown;
  try {
    if (!path || !isAbsolute(path)) return false;
    const directory = realpathSync(join(getServerBaseDir(), ".agent-data", "todo-credentials"));
    const actualDirectory = dirname(realpathSync(path));
    if (process.platform === "win32" ? actualDirectory.toLowerCase() !== directory.toLowerCase() : actualDirectory !== directory) return false;
    const info = statSync(path);
    if (!info.isFile() || (process.platform !== "win32" && (info.mode & 0o077))) return false;
    const descriptor = JSON.parse(readFileSync(path, "utf8"));
    if (descriptor.serviceId !== context.serviceId) return false;
    token = descriptor.token;
    declaredScope = descriptor.scope;
  } catch { return false; }
  let credential;
  try { credential = authenticateTodoCredential(typeof token === "string" ? token : null); }
  catch (error) { if (error instanceof TodoError && error.code === "FORBIDDEN") return false; throw error; }
  if (credential.ownerId !== context.ownerId || credential.serviceId !== context.serviceId
    || credential.scope !== scope || credential.executionId !== context.executionId
    || (credential.sessionId !== undefined && credential.sessionId !== sessionId)) {
    throw new TodoError("FORBIDDEN", "待办凭据的用户、权限或会话身份不匹配");
  }
  return declaredScope === scope;
}

export function createRuntimeTodoContext(sessionId?: string, executionId?: string, model?: string): RuntimeTodoContext {
  const ownerId = anonymousPrincipal().userId;
  const manage = issueTodoCredential({ ownerId, scope: executionId ? "execution" : "manage", sessionId, executionId });
  const relay = sessionId ? issueTodoCredential({ ownerId, scope: "relay", sessionId, executionId }) : undefined;
  return { serviceId: manage.credential.serviceId, ownerId, discoveryDirectory: discoveryDirectory(), descriptorPath: manage.path, ...(relay ? { relayPath: relay.path } : {}), ...(executionId ? { executionId } : {}), ...(model ? { model } : {}) };
}
export function storedRuntimeTodoContext(sessionId: string, seed?: RuntimeTodoContext): RuntimeTodoContext {
  const db = todoServices().db, key = `todo.session.${createHash("sha256").update(sessionId).digest("hex")}`;
  return db.transaction(() => {
    const old = db.prepare("SELECT value FROM settings WHERE key=?").get(key) as { value: string } | undefined;
    let context = old ? JSON.parse(old.value) as RuntimeTodoContext : seed ?? createRuntimeTodoContext(sessionId);
    assertCurrentIdentity(context);
    const scope = context.executionId ? "execution" : "manage";
    const credentialCurrent = currentDescriptor(context.descriptorPath, scope, context, sessionId);
    const relayCurrent = currentDescriptor(context.relayPath, "relay", context, sessionId);
    if (!credentialCurrent) context = createRuntimeTodoContext(sessionId, context.executionId, context.model);
    else {
      context = { ...context, discoveryDirectory: discoveryDirectory() };
      bindTodoCredentialSession(context.descriptorPath, sessionId);
      if (relayCurrent) bindTodoCredentialSession(context.relayPath!, sessionId);
      else context.relayPath = issueTodoCredential({ ownerId: context.ownerId, scope: "relay", sessionId, executionId: context.executionId }).path;
    }
    db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, JSON.stringify(context));
    return context;
  }).immediate();
}
export function readRuntimeTodoContext(sessionId: string): RuntimeTodoContext | undefined {
  const row = todoServices().db.prepare("SELECT value FROM settings WHERE key=?").get(`todo.session.${createHash("sha256").update(sessionId).digest("hex")}`) as { value: string } | undefined;
  return row ? JSON.parse(row.value) : undefined;
}
