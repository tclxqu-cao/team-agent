import { NextResponse } from "next/server";
import { agentHost } from "../../agent-host";

type RegisterTool = {
  scheme: string;
  purpose: string;
  url: string;
  method: "POST";
  headers: Record<string, string>;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  examples: Array<Record<string, unknown>>;
  auth: Record<string, unknown>;
};

type RegisterBody = {
  projectId: string;
  tools: RegisterTool[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> | null {
  if (!isRecord(value)) return null;
  return Object.values(value).every((entry) => typeof entry === "string") ? value as Record<string, string> : null;
}

function objectArray(value: unknown): Array<Record<string, unknown>> | null {
  if (!Array.isArray(value)) return null;
  return value.every(isRecord) ? value as Array<Record<string, unknown>> : null;
}

function parseBody(body: unknown): { success: true; data: RegisterBody } | { success: false; error: string } {
  if (!isRecord(body)) return { success: false, error: "Request body must be an object" };
  if (typeof body.projectId !== "string" || body.projectId.length === 0) return { success: false, error: "projectId is required" };
  if (!Array.isArray(body.tools) || body.tools.length === 0) return { success: false, error: "tools must contain at least one tool" };

  const tools: RegisterTool[] = [];
  for (const tool of body.tools) {
    if (!isRecord(tool)) return { success: false, error: "tool must be an object" };
    if (typeof tool.scheme !== "string" || tool.scheme.length === 0) return { success: false, error: "tool.scheme is required" };
    if (typeof tool.purpose !== "string" || tool.purpose.length === 0) return { success: false, error: "tool.purpose is required" };
    if (typeof tool.url !== "string") return { success: false, error: "tool.url is required" };
    try { new URL(tool.url); } catch { return { success: false, error: "tool.url must be a valid URL" }; }
    if (tool.method !== undefined && tool.method !== "POST") return { success: false, error: "tool.method must be POST" };

    const headers = tool.headers === undefined ? {} : stringRecord(tool.headers);
    const inputSchema = tool.inputSchema === undefined ? {} : tool.inputSchema;
    const outputSchema = tool.outputSchema === undefined ? {} : tool.outputSchema;
    const examples = tool.examples === undefined ? [] : objectArray(tool.examples);
    const auth = tool.auth === undefined ? {} : tool.auth;

    if (!headers) return { success: false, error: "tool.headers must be a string record" };
    if (!isRecord(inputSchema)) return { success: false, error: "tool.inputSchema must be an object" };
    if (!isRecord(outputSchema)) return { success: false, error: "tool.outputSchema must be an object" };
    if (!examples) return { success: false, error: "tool.examples must be an array of objects" };
    if (!isRecord(auth)) return { success: false, error: "tool.auth must be an object" };

    tools.push({
      scheme: tool.scheme,
      purpose: tool.purpose,
      url: tool.url,
      method: "POST",
      headers,
      inputSchema,
      outputSchema,
      examples,
      auth,
    });
  }

  return { success: true, data: { projectId: body.projectId, tools } };
}

function sameOriginBrowserRegistration(request: Request, tools: RegisterTool[]): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;

  let requestOrigin: string;
  try {
    requestOrigin = new URL(origin).origin;
  } catch {
    return false;
  }

  return tools.every((tool) => {
    try {
      return new URL(tool.url).origin === requestOrigin;
    } catch {
      return false;
    }
  });
}

function authorized(request: Request, body: RegisterBody): boolean {
  const authHeader = request.headers.get("authorization");
  const privilegedTokens = [
    process.env.AGENT_ACTION_TOKEN,
    process.env.AGENT_REMOTE_TOOLS_REGISTER_TOKEN,
    process.env.AGENT_SDK_REGISTRATION_TOKEN,
  ].filter((token): token is string => Boolean(token));

  if (privilegedTokens.some((token) => authHeader === `Bearer ${token}`)) return true;

  const sdkToken = process.env.AGENT_SDK_TOKEN;
  if (!sdkToken || authHeader !== `Bearer ${sdkToken}`) return false;
  return sameOriginBrowserRegistration(request, body.tools);
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = parseBody(body);
  if (!parsed.success) return NextResponse.json({ error: parsed.error }, { status: 400 });
  if (!authorized(request, parsed.data)) return NextResponse.json({ error: "UNAUTHORIZED" }, { status: 401 });

  const tools = agentHost.registerRemoteTools(parsed.data.projectId, parsed.data.tools);
  return NextResponse.json({ ok: true, tools: tools.map((tool) => ({ scheme: tool.scheme, purpose: tool.purpose })) });
}
