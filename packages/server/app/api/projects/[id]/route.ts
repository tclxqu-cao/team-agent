import { NextResponse } from "next/server";
import { projectErrorResponse, webProjectService } from "../project-http";

type RouteContext = { params: { id: string } };

export async function GET(_request: Request, { params }: RouteContext) {
  try {
    return NextResponse.json(await webProjectService.get(params.id));
  } catch (error) {
    const response = projectErrorResponse(error);
    return NextResponse.json(response.body, { status: response.status });
  }
}

export async function PATCH(request: Request, { params }: RouteContext) {
  try {
    const body = await request.json() as { name?: string };
    return NextResponse.json(await webProjectService.rename(params.id, body.name ?? ""));
  } catch (error) {
    const response = projectErrorResponse(error);
    return NextResponse.json(response.body, { status: response.status });
  }
}

export async function DELETE(_request: Request, { params }: RouteContext) {
  try {
    await webProjectService.delete(params.id);
    return NextResponse.json({ deleted: true, projectId: params.id });
  } catch (error) {
    const response = projectErrorResponse(error);
    return NextResponse.json(response.body, { status: response.status });
  }
}
