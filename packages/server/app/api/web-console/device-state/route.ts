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

export async function GET() {
  const { userId, deviceId } = anonymousPrincipal();
  return NextResponse.json({
    deviceState: webConsoleStore.getDeviceState(userId, deviceId) ?? defaults(userId, deviceId),
  });
}

export async function PUT(request: Request) {
  const { userId, deviceId } = anonymousPrincipal();
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
