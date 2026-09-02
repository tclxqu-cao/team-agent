import { NextResponse } from "next/server";
import { projectErrorResponse, webProjectService } from "../project-http";

export async function GET(request: Request) {
  try {
    const path = new URL(request.url).searchParams.get("path") ?? "";
    return NextResponse.json(webProjectService.directories(path));
  } catch (error) {
    const response = projectErrorResponse(error);
    return NextResponse.json(response.body, { status: response.status });
  }
}
