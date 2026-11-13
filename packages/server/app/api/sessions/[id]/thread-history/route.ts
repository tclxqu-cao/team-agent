import { NextResponse } from "next/server";
import { StaleSessionAnchorError } from "@agent/core";
import { loadEngineThreadHistory, loadEngineThreadHistoryItem } from "../../../../../lib/engine-switch/history";

export async function GET(request: Request, { params }: { params: { id: string } }) {
  try {
    const url = new URL(request.url);
    const itemId = url.searchParams.get("itemId");
    if (itemId) {
      const item = await loadEngineThreadHistoryItem(params.id, itemId);
      if (!item) return NextResponse.json({ error: "History item not found" }, { status: 404 });
      const offset = Math.max(0, Math.floor(Number(url.searchParams.get("textOffset")) || 0));
      const maxChars = Math.max(1, Math.min(16_000, Math.floor(Number(url.searchParams.get("maxChars")) || 4_000)));
      const text = item.content.slice(offset, offset + maxChars);
      return NextResponse.json({ item: { ...item, content: text },
        nextTextOffset: offset + text.length < item.content.length ? offset + text.length : null });
    }
    const limit = Number(url.searchParams.get("limit")) || 100;
    const detail = await loadEngineThreadHistory(params.id, {
      limit,
      before: url.searchParams.get("before") || undefined,
      after: url.searchParams.get("after") || undefined,
      anchor: url.searchParams.get("anchor") || undefined,
    });
    if (!detail) return NextResponse.json({ threadKey: null, activeSessionId: params.id, messages: [], segments: [] });
    return NextResponse.json({ ...detail,
      truncated: detail.history?.hasMore === true || !!detail.history?.newerCursor,
      omitted: Math.max(0, (detail.history?.totalItems ?? 0) - (detail.history?.pageSize ?? 0)),
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to read thread history",
      ...(error instanceof StaleSessionAnchorError ? { code: error.code } : {}) },
      { status: error instanceof StaleSessionAnchorError ? 409 : 500 });
  }
}
