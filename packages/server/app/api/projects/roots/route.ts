import { NextResponse } from "next/server";
import { projectErrorResponse, webProjectService } from "../project-http";

export async function GET(request: Request) {
  try {
    return NextResponse.json(
      new URL(request.url).searchParams.has("picker")
        ? webProjectService.pickerLocation()
        : webProjectService.roots(),
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    const response = projectErrorResponse(error);
    return NextResponse.json(response.body, { status: response.status });
  }
}
