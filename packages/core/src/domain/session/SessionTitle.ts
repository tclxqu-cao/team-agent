import type { Session } from "./entities.js";

export const NEW_SESSION_PLACEHOLDER_TITLE = "新会话";
export const AUTO_TITLE_PENDING_METADATA_KEY = "autoTitleFromFirstMessage";

export function withPendingAutoTitle(
  title: string,
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  return title === NEW_SESSION_PLACEHOLDER_TITLE
    ? { ...metadata, [AUTO_TITLE_PENDING_METADATA_KEY]: true }
    : metadata;
}

export function consumePendingAutoTitle(
  session: Pick<Session, "metadata">,
  input: string,
): { title: string; metadata: Record<string, unknown> } | null {
  if (session.metadata[AUTO_TITLE_PENDING_METADATA_KEY] !== true || !input.trim()) {
    return null;
  }

  const metadata = { ...session.metadata };
  delete metadata[AUTO_TITLE_PENDING_METADATA_KEY];
  return { title: input.slice(0, 60), metadata };
}
