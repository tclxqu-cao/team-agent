import { NextResponse } from "next/server";
import { businessCatalog } from "../../../../lib/business-catalog";


export async function GET() {
  const servers = await businessCatalog().mcp.listAll();
  return NextResponse.json(servers);
}
