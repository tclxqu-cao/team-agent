import { NextResponse } from "next/server";
import { validateComputerConnections } from "@agent/core";
import { anonymousPrincipal, webConsoleStore } from "../../../../lib/web-auth/anonymous";

export const dynamic = "force-dynamic";
const respond = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
const invalid = (cause: unknown) => respond({ error: { code: "INVALID_COMPUTER_DIRECTORY", message: cause instanceof Error ? cause.message : "电脑列表无效。" } }, 400);

export async function GET() {
  return respond({ computers: webConsoleStore.listComputerConnections(anonymousPrincipal().userId) });
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (!body || Array.isArray(body) || typeof body !== "object" || Object.keys(body).some(key => !["computers", "restore"].includes(key))
      || (body.restore !== undefined && typeof body.restore !== "boolean")) throw new Error("电脑列表参数无效。");
    const computers = validateComputerConnections(body.computers);
    return respond({ computers: webConsoleStore.mergeComputerConnections(anonymousPrincipal().userId, computers, body.restore === true) });
  } catch (cause) { return invalid(cause); }
}

export async function DELETE(request: Request) {
  try {
    const body = await request.json();
    if (!body || Array.isArray(body) || typeof body !== "object" || Object.keys(body).some(key => key !== "origin")) throw new Error("电脑列表参数无效。");
    const [connection] = validateComputerConnections([{ origin: body.origin, name: "电脑" }]);
    const currentOrigin = new URL(request.headers.get("origin") || request.url).origin;
    if (connection.origin === currentOrigin) throw new Error("不能删除当前连接的电脑。");
    const { userId } = anonymousPrincipal();
    webConsoleStore.removeComputerConnection(userId, connection.origin);
    return respond({ computers: webConsoleStore.listComputerConnections(userId) });
  } catch (cause) { return invalid(cause); }
}

export async function PATCH(request: Request) {
  try {
    const body = await request.json();
    const [connection] = validateComputerConnections([body]);
    const { userId } = anonymousPrincipal();
    if (!webConsoleStore.renameComputerConnection(userId, connection)) {
      return respond({ error: { code: "COMPUTER_NOT_FOUND", message: "电脑尚未添加，请重新加载列表。" } }, 404);
    }
    return respond({ computers: webConsoleStore.listComputerConnections(userId) });
  } catch (cause) { return invalid(cause); }
}
