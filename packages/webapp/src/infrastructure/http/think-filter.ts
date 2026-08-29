/**
 * Reasoning-tag filter for model output.
 *
 * Some models (and relays) stream their chain-of-thought wrapped in
 * `<think>…</think>` — including empty blocks — as literal text. The chat UI
 * should never render those tags, so text passes through this filter before
 * being shown.
 *
 * The streaming variant is chunk-boundary safe: a tag may arrive split across
 * consecutive events ("<thi" + "nk>…"), so a possible partial tag suffix is
 * held back until it is resolved.
 */

const OPEN = "<think>";
const CLOSE = "</think>";

/** Length of the longest suffix of `text` that is a prefix of `tag` (< tag.length). */
function partialSuffixLen(text: string, tag: string): number {
  const max = Math.min(tag.length - 1, text.length);
  for (let len = max; len > 0; len--) {
    if (text.endsWith(tag.slice(0, len))) return len;
  }
  return 0;
}

/** Strip every complete <think>…</think> block from a whole string. */
export function stripThinkBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "");
}

/**
 * Incremental filter for streamed text chunks. Feed every chunk in order;
 * the returned value is the text safe to display immediately.
 */
export class StreamingThinkFilter {
  private buffer = "";
  private dropping = false;

  push(chunk: string): string {
    this.buffer += chunk;
    let out = "";
    for (;;) {
      if (this.dropping) {
        const end = this.buffer.indexOf(CLOSE);
        if (end === -1) {
          // Still inside a think block — discard everything except a partial
          // closing tag that may be completed by the next chunk.
          const keep = partialSuffixLen(this.buffer, CLOSE);
          this.buffer = this.buffer.slice(this.buffer.length - keep);
          return out;
        }
        this.buffer = this.buffer.slice(end + CLOSE.length);
        this.dropping = false;
        continue;
      }
      const start = this.buffer.indexOf(OPEN);
      if (start === -1) {
        const keep = partialSuffixLen(this.buffer, OPEN);
        out += this.buffer.slice(0, this.buffer.length - keep);
        this.buffer = this.buffer.slice(this.buffer.length - keep);
        return out;
      }
      out += this.buffer.slice(0, start);
      this.buffer = this.buffer.slice(start + OPEN.length);
      this.dropping = true;
    }
  }

  /** Flush any held-back tail (call when the run finishes). */
  flush(): string {
    const tail = this.buffer;
    this.buffer = "";
    return tail;
  }
}
