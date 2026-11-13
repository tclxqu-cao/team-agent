import type { AgentEvent } from "../../domain/agent/entities.js";
import type { EngineSwitchRepository } from "../../domain/engine-switch/EngineSwitchRepository.js";
import { HANDOFF_INPUT_SEPARATOR } from "../../domain/engine-switch/thread-history.js";

/** Used at the common native execution boundary, including durable queues. */
export class EngineSwitchDelivery {
  constructor(private readonly repository: EngineSwitchRepository) {}

  prepare(sessionId: string, input: string, images?: string[]) {
    const handoff = this.repository.handoffs.pendingForSession(sessionId);
    if (!handoff) return { input, images, confirm: (_event: AgentEvent): void => {} };
    const combined = [...new Set([...(images ?? []), ...(handoff.images ?? [])])];
    if (combined.length > 8) throw new Error("当前输入与交接图片超过 8 张，请减少本次图片后重试；历史图片仍保存在交接文件中");
    let confirmed = false;
    return {
      input: `${handoff.summaryText}${HANDOFF_INPUT_SEPARATOR}${input}`,
      images: combined.length ? combined : undefined,
      confirm: (event: AgentEvent): void => {
        if (confirmed) return;
        const accepted = event.type === "done" || event.type === "tool_call"
          || (event.type === "text_chunk" && !!event.text)
          || (event.type === "reasoning_summary_delta" && !!event.delta);
        if (!accepted) return;
        this.repository.handoffs.markConsumed(handoff.id, new Date().toISOString());
        confirmed = true;
      },
    };
  }
}
