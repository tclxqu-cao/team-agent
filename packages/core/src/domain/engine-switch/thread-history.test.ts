import { describe, expect, it } from "vitest";
import { cleanEngineHistory, engineThreadPhases, HANDOFF_INPUT_SEPARATOR, scopedHistory } from "./thread-history";
import type { EngineSwitchRecord, EngineSwitchSessionView, ContextHandoff } from "./entities";
import type { Message } from "../model/entities";

const msg = (content: string, historyId?: string): Message => ({ role: "user", content, historyId });
const record = (from: string, to: string, snapshot: Message[], phase: Message[]): EngineSwitchRecord => ({
  id: `${from}-${to}`, threadKey: "t", fromSessionId: from, toSessionId: to,
  fromAgentType: "codex", toAgentType: "claude-code", strategy: "create", handoffId: null,
  coveredThroughHistoryId: snapshot.at(-1)?.historyId ?? null, sourceSnapshot: snapshot, phaseMessages: phase, at: "now",
});
const active = (id: string, messages: Message[]): EngineSwitchSessionView => ({
  id, agentType: "codex", title: "test", cwd: "/tmp", status: "idle", occupancy: "available", messages,
});

describe("thread history", () => {
  it("keeps A-B-A-C phases in order even if the source is reused", () => {
    const a = [msg("A1", "a1")], b = [msg("B1", "b1")], later = [...a, msg("A2", "a2")];
    const phases = engineThreadPhases([
      record("A", "B", a, scopedHistory(a, "A")),
      record("B", "A", b, scopedHistory(b, "B")),
      record("A", "C", later, scopedHistory(later, "A", 1)),
    ], active("C", []));
    expect(phases.flatMap((phase) => phase.messages.map((message) => message.content))).toEqual(["A1", "B1", "A2"]);
  });

  it("uses exact opaque boundaries to reconstruct old records", () => {
    const first = record("A", "B", [], []);
    delete first.sourceSnapshot; delete first.phaseMessages;
    first.coveredThroughHistoryId = "opaque:uuid-a";
    const phases = engineThreadPhases([first], active("B", []),
      new Map([["A", active("A", [msg("before", "opaque:uuid-a"), msg("after", "opaque:uuid-b")])]]));
    expect(phases[0].messages.map((message) => message.content)).toEqual(["before"]);
  });

  it("namespaces repeated prompts and removes transport envelopes", () => {
    expect(scopedHistory([msg("继续")], "A")[0].historyId).not.toBe(scopedHistory([msg("继续")], "B")[0].historyId);
    const h = { summaryText: "HISTORY" } as ContextHandoff;
    expect(cleanEngineHistory([msg(`HISTORY${HANDOFF_INPUT_SEPARATOR}actual`)], [h])[0].content).toBe("actual");
    expect(cleanEngineHistory([msg("HISTORY\n\n---\n\nactual")], [h])[0].content).toBe("actual");
  });
});
