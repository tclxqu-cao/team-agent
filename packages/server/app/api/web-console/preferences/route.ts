import { NextResponse } from "next/server";
import { WEB_ANON_USER_ID, webConsoleStore } from "../../../../lib/web-auth/anonymous";

const defaults = () => ({
  userId: WEB_ANON_USER_ID,
  revision: 1,
  theme: "black",
  terminalFontSize: 11,
  fileButtonPosition: { xRatio: .94, yRatio: .65, anchor: "right" },
  keybarPosition: { xRatio: .5, yRatio: .95, anchor: "bottom" },
  keybarHidden: false,
  keyOrder: [],
  updatedAt: new Date().toISOString(),
});

export async function GET() {
  return NextResponse.json({
    preferences: webConsoleStore.getPreferences(WEB_ANON_USER_ID) ?? defaults(),
  });
}

export async function PATCH(request: Request) {
  const current = webConsoleStore.getPreferences(WEB_ANON_USER_ID) ?? defaults();
  const body = await request.json();
  const next = {
    ...current,
    ...body,
    userId: WEB_ANON_USER_ID,
    revision: current.revision + 1,
    updatedAt: new Date().toISOString(),
  };
  const stored = webConsoleStore.getPreferences(WEB_ANON_USER_ID);
  if (!webConsoleStore.savePreferences(next, stored ? current.revision : null)) {
    return NextResponse.json(
      { error: { code: "REVISION_CONFLICT", message: "偏好已在其他设备更新" } },
      { status: 409 },
    );
  }
  return NextResponse.json({ preferences: next });
}
