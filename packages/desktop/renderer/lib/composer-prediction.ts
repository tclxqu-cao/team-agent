/** Use only a follow-up already stated by the assistant when native predictions are unavailable. */
export function followUpFromReply(reply: string): string | null {
  const lines = reply.slice(-8_000).replace(/```[\s\S]*?(?:```|$)/g, "").split("\n").reverse();
  for (const line of lines) {
    const text = line.trim().replace(/^(?:[-*] |\d+\. )/, "").replace(/\*\*|__/g, "");
    const chinese = /^(?:下一步(?:可以|建议|需要)?|接下来(?:可以|建议|需要)?|首次需要|我可以|建议先)[：:，,\s]*(.+)/.exec(text);
    const english = /^(?:(?:the )?next step(?:\s+is\s+to|\s+would\s+be\s+to|\s*[:–—-])|i can)\s+(.+)/i.exec(text);
    const action = (chinese ?? english)?.[1]?.split(/(?<=[。！？])|(?<=[.!?])\s+/)[0].trim();
    if (!action || action.length < 5 || action.length > 220 || /[?？]$/.test(action)) continue;
    if (chinese) return `请${action.replace(/^请/, "")}`;
    return action.charAt(0).toUpperCase() + action.slice(1);
  }
  return null;
}
