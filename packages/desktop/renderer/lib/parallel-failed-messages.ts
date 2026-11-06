import type { ParallelConversation } from "../global";
import type { FailedParallelMessage, ParallelMessage } from "./parallel-message-dispatch";
import type { SessionImageDraftRepository } from "./session-image-draft";

interface StoredFailure { sessionId: string; message: ParallelMessage; error: string; hasImages: boolean }
const prefix = "agentroam.parallel-failed.v1:";
const imageKey = (groupId: string, entry: StoredFailure) => `${prefix}${groupId}:${entry.sessionId}:${entry.message.sourceMessageId}`;

/** Retry receipts are small; image bytes use the existing IndexedDB draft repository. */
export class ParallelFailedMessageRepository {
  constructor(private readonly storage: Pick<Storage, "getItem" | "setItem">, private readonly images: SessionImageDraftRepository) {}

  private entries(groupId: string): StoredFailure[] {
    try {
      const rows: unknown = JSON.parse(this.storage.getItem(prefix + groupId) || "[]");
      return Array.isArray(rows) ? rows.filter((row): row is StoredFailure => Boolean(row && typeof row === "object"
        && typeof row.sessionId === "string" && typeof row.error === "string"
        && row.message && typeof row.message.content === "string" && typeof row.message.sourceMessageId === "string")) : [];
    } catch { return []; }
  }

  async read(group: ParallelConversation): Promise<FailedParallelMessage[]> {
    return (await Promise.all(this.entries(group.id).map(async (row): Promise<FailedParallelMessage | null> => {
      const member = group.members.find(item => item.id === row.sessionId);
      if (!member) return null;
      const images = row.hasImages ? await this.images.read(imageKey(group.id, row)) : [];
      const blocked = row.hasImages && !images.length;
      return { member, message: { ...row.message, ...(images.length ? { images } : {}) },
        error: blocked ? `${row.error}；附件未恢复，请重新添加后发送` : row.error, ...(blocked ? { blocked } : {}),
      };
    }))).filter((row): row is FailedParallelMessage => row !== null);
  }

  async write(group: ParallelConversation, failures: FailedParallelMessage[]): Promise<void> {
    const previous = this.entries(group.id);
    const entries: StoredFailure[] = [];
    for (const failure of failures) {
      const { images, ...message } = failure.message;
      const entry = { sessionId: failure.member.id, message, error: failure.error, hasImages: Boolean(images?.length || failure.blocked) };
      if (!failure.blocked) await this.images.write(imageKey(group.id, entry), images ?? []);
      entries.push(entry);
    }
    this.storage.setItem(prefix + group.id, JSON.stringify(entries));
    const retained = new Set(entries.map(entry => imageKey(group.id, entry)));
    await Promise.all(previous.filter(entry => !retained.has(imageKey(group.id, entry))).map(entry => this.images.clear(imageKey(group.id, entry))));
  }
}
