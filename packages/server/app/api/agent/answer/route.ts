import { NextResponse } from "next/server";
import { agentHost } from "../../agent-host";
import { getNativeRuntimeService } from "../../../../lib/native-runtime-service";

export async function POST(request: Request) {
  try {
    const body = await request.json() as {
      questionId: string;
      answer: string;
      selectedIndices?: number[];
    };

    if (!body.questionId || !body.answer) {
      return NextResponse.json(
        { error: "questionId and answer are required" },
        { status: 400 },
      );
    }

    let resolved = agentHost.answerQuestion(
      body.questionId,
      body.answer,
      body.selectedIndices,
    );

    if (!resolved) {
      resolved = await getNativeRuntimeService().answerQuestion(body.questionId, {
        answer: body.answer,
        selectedIndices: body.selectedIndices,
      });
    }

    if (!resolved) {
      return NextResponse.json(
        { error: "Question not found or already answered" },
        { status: 404 },
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal error" },
      { status: 500 },
    );
  }
}
