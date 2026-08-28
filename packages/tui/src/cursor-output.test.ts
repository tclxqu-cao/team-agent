import { describe, expect, it } from "vitest";
import { CURSOR_ANCHOR, createCursorAwareOutput } from "./cursor-output.js";

function fixture() {
  const writes: string[] = [];
  const stream = {
    isTTY: true,
    columns: 80,
    rows: 24,
    write(chunk: unknown) {
      writes.push(String(chunk));
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  return { writes, output: createCursorAwareOutput(stream) };
}

describe("cursor-aware Ink output", () => {
  it("parks the real cursor at a CJK-aware anchor and restores before redraw", () => {
    const { writes, output } = fixture();
    output.stdout.write(`header\n│ › 当前${CURSOR_ANCHOR}是什么\n│ hint\n╰──\n`);

    expect(writes[0]).not.toContain(CURSOR_ANCHOR);
    expect(writes[0]?.endsWith("\u001b[3A\u001b[9G\u001b[?25h")).toBe(true);

    output.stdout.write("\u001b[?25l");
    expect(writes).toHaveLength(1);

    output.stdout.write(`header\n│ › 当前是${CURSOR_ANCHOR}什么\n│ hint\n╰──\n`);
    expect(writes[1]?.startsWith("\u001b[?25l\u001b[3B\u001b[1G")).toBe(true);
    expect(writes[1]?.endsWith("\u001b[3A\u001b[11G\u001b[?25h")).toBe(true);
  });

  it("returns the cursor below the Ink frame when the app exits", () => {
    const { writes, output } = fixture();
    output.stdout.write(`message ${CURSOR_ANCHOR}\nhint\nborder\n`);
    output.restore();

    expect(writes.at(-1)).toBe("\u001b[?25l\u001b[3B\u001b[1G\u001b[?25h");
  });
});
