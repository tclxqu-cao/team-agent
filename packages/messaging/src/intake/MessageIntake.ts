import type { ChannelMessage } from "../domain/types.js";
import type { MessageSource, MessagingRepository } from "../application/ports.js";

/** Incoming messages and verification refreshes share one source read at a time. */
export class MessageIntake {
  private collecting?: Promise<void>;
  constructor(private readonly repository: Pick<MessagingRepository, "insert">, private readonly source: MessageSource) {}
  receive(source: ChannelMessage) { return this.repository.insert(source); }
  discover() { return this.source.discover(); }
  collect(): Promise<void> {
    return this.collecting ??= Promise.resolve().then(() => this.source.collect()).finally(() => { this.collecting = undefined; });
  }
}
