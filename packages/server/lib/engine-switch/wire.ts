import type { ContextHandoff, EngineSwitchRecord } from "@agent/core";

/** Newest ids worth listing on the wire; the stored artifact keeps them all. */
export const WIRE_OMITTED_LIST_LIMIT = 20;

/**
 * The stored handoff keeps every omitted historyId for audit and on-demand
 * reads. Shipping 2000+ ids to a client per switch is pure payload waste, so
 * the wire shape lists only the newest handful plus the full count.
 */
export function handoffForWire(handoff: ContextHandoff): ContextHandoff & { omittedCount: number } {
  const { images: _images, ...metadata } = handoff;
  return {
    ...metadata,
    omittedHistoryIds: handoff.omittedHistoryIds.slice(-WIRE_OMITTED_LIST_LIMIT),
    omittedCount: handoff.omittedHistoryIds.length,
  };
}

export function switchRecordForWire(record: EngineSwitchRecord) {
  const { sourceSnapshot: _snapshot, phaseMessages: _messages, ...metadata } = record;
  return metadata;
}
