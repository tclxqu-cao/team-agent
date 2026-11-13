import { NextResponse } from "next/server";
import { getEngineSwitchContainer } from "../../../../../lib/engine-switch/container";
import { handoffForWire, switchRecordForWire } from "../../../../../lib/engine-switch/wire";

/**
 * GET /api/sessions/[id]/engine-switches
 *
 * Auditable switch ledger: the logical thread this session belongs to, its
 * current engine, and every switch record plus its handoff artifact (summary
 * text, omitted item IDs, strategy).
 */
export async function GET(
  _request: Request,
  { params }: { params: { id: string } },
) {
  try {
    const { ledger } = getEngineSwitchContainer();
    const { thread, records } = ledger.ledger(params.id);
    return NextResponse.json({
      thread,
      records: records.map((record) => {
        // `handoffForRecord` takes the record id and joins through handoff_id.
        const handoff = ledger.handoffForRecord(record.id);
        return {
          ...switchRecordForWire(record),
          handoff: handoff ? handoffForWire(handoff) : undefined,
        };
      }),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to read switch ledger" },
      { status: 500 },
    );
  }
}
