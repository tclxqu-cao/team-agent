import { NextResponse } from "next/server";
import { getNativeRuntimeService } from "../../../../lib/native-runtime-service";

export async function GET() {
  const native = await getNativeRuntimeService().health();
  return NextResponse.json([
    { agentType: "customer-agent", available: true, label: "Customer Agent" },
    ...native,
  ]);
}
