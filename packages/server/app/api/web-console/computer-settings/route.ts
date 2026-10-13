import { NextResponse } from "next/server";
import { defaultComputerSettings, validateComputerTools, validateSavedComputerPages } from "@agent/core";
import { anonymousPrincipal, webConsoleStore } from "../../../../lib/web-auth/anonymous";

export const dynamic = "force-dynamic";
const respond = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function GET() {
  const { userId } = anonymousPrincipal();
  return respond({ settings: webConsoleStore.getComputerSettings(userId) ?? defaultComputerSettings(userId) });
}

export async function PATCH(request: Request) {
  const { userId } = anonymousPrincipal();
  const stored = webConsoleStore.getComputerSettings(userId);
  const current = stored ?? defaultComputerSettings(userId);
  let next;
  let initialize = false;
  let expectedRevision: number;
  try {
    const body = await request.json();
    const allowed = ["expectedRevision", "visibleTools", "savedPages", "initializePages"];
    if (!body || Array.isArray(body) || typeof body !== "object" || Object.keys(body).some(key => !allowed.includes(key))) throw new Error("电脑配置参数无效。");
    if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision < 0) throw new Error("缺少有效的配置版本，请重新加载。");
    expectedRevision = body.expectedRevision;
    const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key);
    initialize = has("initializePages");
    if (initialize && (has("savedPages") || has("visibleTools"))) throw new Error("旧页面导入不能与其他配置同时修改。");
    if (!initialize && !has("visibleTools") && !has("savedPages")) throw new Error("请选择要保存的配置。");
    next = {
      ...current,
      visibleTools: has("visibleTools") ? validateComputerTools(body.visibleTools) : current.visibleTools,
      savedPages: initialize ? validateSavedComputerPages(body.initializePages) : has("savedPages") ? validateSavedComputerPages(body.savedPages) : current.savedPages,
      revision: current.revision + 1,
      updatedAt: new Date().toISOString(),
    };
  } catch (cause) {
    return respond({ error: { code: "INVALID_COMPUTER_SETTINGS", message: cause instanceof Error ? cause.message : "电脑配置无效。" } }, 400);
  }
  // A retried import must never restore pages already deleted in the database.
  if (initialize && current.savedPages !== null) return respond({ settings: current });
  if (expectedRevision !== current.revision || !webConsoleStore.saveComputerSettings(next, stored ? current.revision : null)) {
    return respond({ error: { code: "REVISION_CONFLICT", message: "配置已在其他设备更新，请重新加载后重试。" } }, 409);
  }
  return respond({ settings: next });
}
