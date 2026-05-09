import { NextResponse } from "next/server";
import { FileSystemMemoryStore } from "@agent/core";

const memoryStore = new FileSystemMemoryStore(process.cwd());

export async function GET(
  _request: Request,
  { params }: { params: { key: string } },
) {
  const entry = await memoryStore.get(params.key);
  if (!entry) {
    return NextResponse.json({ error: "Memory not found" }, { status: 404 });
  }
  return NextResponse.json(entry);
}

export async function DELETE(
  _request: Request,
  { params }: { params: { key: string } },
) {
  await memoryStore.delete(params.key);
  return NextResponse.json({ status: "deleted" });
}
