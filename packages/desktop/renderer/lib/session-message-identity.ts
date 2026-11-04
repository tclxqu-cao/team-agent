/** Keep the newest copy of each identity without changing a clean message list. */
export function uniqueSessionMessages<T extends { id: string }>(messages: T[]): T[] {
  const seen = new Set<string>();
  const retained: T[] = [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (seen.has(message.id)) continue;
    seen.add(message.id);
    retained.push(message);
  }
  return retained.length === messages.length ? messages : retained.reverse();
}
