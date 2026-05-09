import { NextResponse } from "next/server";
import { FileSystemMemoryStore, type MemoryEntry } from "@agent/core";

const memoryStore = new FileSystemMemoryStore(process.cwd());

export async function GET(request: Request) {
  const url = new URL(request.url);
  const q = url.searchParams.get("q");

  if (q) {
    const results = await memoryStore.search(q);
    return NextResponse.json(results);
  }

  const entries = await memoryStore.list();
  return NextResponse.json(entries);
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as MemoryEntry;
    if (!body.name || !body.content) {
      return NextResponse.json(
        { error: "name and content are required" },
        { status: 400 },
      );
    }
    await memoryStore.set(body);
    return NextResponse.json({ status: "saved" }, { status: 201 });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Save failed" },
      { status: 500 },
    );
  }
}
