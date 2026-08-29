import { NextResponse } from "next/server";
import { agentHost } from "../../agent-host";

export async function POST(request: Request) {
  try {
    const body = await request.json() as {
      input: string;
      sessionId?: string;
      images?: string[];
      model?: { provider: string; apiKey: string; modelId: string; baseUrl?: string };
    };

    if (!body.input) {
      return NextResponse.json({ error: "input is required" }, { status: 400 });
    }

    const sessionId = body.sessionId ?? crypto.randomUUID();
    const sessionStore = agentHost.getSessionStore();
    let session = await sessionStore.get(sessionId);
    if (!session) {
      const now = new Date().toISOString();
      session = await sessionStore.create({
        id: sessionId,
        projectId: "",
        title: `Chat ${now}`,
        status: "idle",
        messages: [],
        events: [],
        created: now,
        updated: now,
        metadata: {},
      });
    }

    // Configure model if provided
    if (body.model) {
      agentHost.getBuilder().withModel(body.model.provider, {
        apiKey: body.model.apiKey,
        modelId: body.model.modelId,
        baseUrl: body.model.baseUrl,
      });
    }

    // Run agent in background
    agentHost.run(body.input, sessionId, body.images).catch((err) => {
      console.error("Agent run error:", err);
    });

    return NextResponse.json({
      sessionId: session.id,
      streamUrl: `/api/agent/stream?sessionId=${session.id}`,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal error" },
      { status: 500 },
    );
  }
}
