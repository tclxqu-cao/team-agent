import { NextResponse } from "next/server";
import { anonymousPrincipal, webConsoleStore } from "../../../../lib/web-auth/anonymous";

export const dynamic = "force-dynamic";

const defaults = (userId: string, deviceId: string) => ({
  userId,
  deviceId,
  activeTerminalId: null,
  drawerOpen: false,
  drawerTab: "files",
  fileTreeRoot: null,
  fileTreeFollowMode: true,
  expandedPaths: [],
  selectedFile: null,
  terminalScroll: {},
  updatedAt: new Date().toISOString(),
});

export async function GET(request: Request) {
  const { userId } = anonymousPrincipal();
  const deviceId = request.headers.get("x-agentroam-device-id");
  if (!deviceId) return NextResponse.json({ error: "Device authorization required" }, { status: 401 });
  return NextResponse.json({
    deviceState: webConsoleStore.getDeviceState(userId, deviceId) ?? defaults(userId, deviceId),
  });
}

export async function PUT(request: Request) {
  const { userId } = anonymousPrincipal();
  const deviceId = request.headers.get("x-agentroam-device-id");
  if (!deviceId) return NextResponse.json({ error: "Device authorization required" }, { status: 401 });
  const current = webConsoleStore.getDeviceState(userId, deviceId) ?? defaults(userId, deviceId);
  const body = await request.json();
  const next = {
    ...current,
    ...body,
    userId,
    deviceId,
    updatedAt: new Date().toISOString(),
  };
  webConsoleStore.saveDeviceState(next);
  return NextResponse.json({ deviceState: next });
}
