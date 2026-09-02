import { NextResponse } from "next/server";
import { projectErrorResponse, webProjectService } from "./project-http";

export async function GET() {
  return NextResponse.json(await webProjectService.list());
}

export async function POST(request: Request) {
  try {
    const body = await request.json() as { name?: string; path?: string };
    return NextResponse.json(
      await webProjectService.create(body.path ?? "", body.name),
      { status: 201 },
    );
  } catch (error) {
    const response = projectErrorResponse(error);
    return NextResponse.json(response.body, { status: response.status });
  }
}
