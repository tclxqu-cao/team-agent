/** Display-only projection of Codex's scheduled-task envelope. */
export function scheduledMessageContent(text: string): string | null {
  const envelope = text.trim().match(/^<heartbeat>([\s\S]*)<\/heartbeat>$/);
  if (!envelope) return null;
  const inner = envelope[1];
  const start = inner.indexOf("<instructions>");
  const end = inner.lastIndexOf("</instructions>");
  if (start < 0 || end < start) return null;
  const metadata = inner.slice(0, start) + inner.slice(end + "</instructions>".length);
  if (!/<automation_id>[^<>]+<\/automation_id>/.test(metadata)) return null;
  if (metadata.replace(/<(automation_id|current_time_iso)>[^<>]*<\/\1>/g, "").trim()) return null;
  return inner.slice(start + "<instructions>".length, end).trim();
}
