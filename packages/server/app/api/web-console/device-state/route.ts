import { NextResponse } from "next/server";
import { WEB_ANON_DEVICE_ID, WEB_ANON_USER_ID, webConsoleStore } from "../../../../lib/web-auth/anonymous";

const defaults = () => ({
  userId: WEB_ANON_USER_ID,
  deviceId: WEB_ANON_DEVICE_ID,
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
  return NextResponse.json({
    deviceState: webConsoleStore.getDeviceState(WEB_ANON_USER_ID, WEB_ANON_DEVICE_ID) ?? defaults(),
  });
}

export async function PUT(request: Request) {
  const current = webConsoleStore.getDeviceState(WEB_ANON_USER_ID, WEB_ANON_DEVICE_ID) ?? defaults();
  const body = await request.json();
  const next = {
    ...current,
    ...body,
    userId: WEB_ANON_USER_ID,
    deviceId: WEB_ANON_DEVICE_ID,
    updatedAt: new Date().toISOString(),
  };
  webConsoleStore.saveDeviceState(next);
  return NextResponse.json({ deviceState: next });
}
