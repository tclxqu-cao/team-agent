import type { AgentEvent } from "@agent/core";

export class AgentEventBuffer {
  private pendingText = "";
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly emit: (event: AgentEvent) => void,
    private readonly delayMs = 80,
  ) {}

  push(event: AgentEvent): void {
    if (event.type !== "text_chunk") {
      this.flush();
      this.emit(event);
      return;
    }

    this.pendingText += event.text;
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, this.delayMs);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.pendingText) return;
    const text = this.pendingText;
    this.pendingText = "";
    this.emit({ type: "text_chunk", text });
  }

  dispose(): void {
    this.flush();
  }
}
