import { describe, expect, it, vi } from "vitest";
import { Terminal } from "@xterm/xterm";
import { createTerminalOutput } from "./terminalOutput";

const encode = (text: string) => new TextEncoder().encode(text);

describe("terminal output replay", () => {
  it("does not send historical device queries to the shell, but answers live queries", async () => {
    const terminal = new Terminal({ allowProposedApi: true });
    const responses: string[] = [];
    terminal.onData((data) => responses.push(data));
    const queries = encode("\x1b[6n\x1b[c\x1b[5n");
    let writes = 0;
    try {
      await new Promise<void>((resolve) => {
        const output = createTerminalOutput(terminal, () => {
          writes++;
          if (writes === 1) expect(responses).toEqual([]);
          if (writes === 2) resolve();
        });
        output.reset();
        output.write(queries, true);
        output.write(queries, false);
      });
      expect(responses).toEqual(["\x1b[1;1R", "\x1b[?1;2c", "\x1b[0n"]);
      expect(terminal.options.disableStdin).toBe(false);
    } finally {
      terminal.dispose();
    }
  });

  it("serializes async replay, reset, and live output without leaking the replay flag", () => {
    const callbacks: Array<() => void> = [];
    const terminal = {
      options: { disableStdin: false },
      write: vi.fn((_data: Uint8Array, callback: () => void) => callbacks.push(callback)),
      reset: vi.fn(),
    };
    const output = createTerminalOutput(terminal, vi.fn());
    output.write(encode("history"), true);
    output.reset();
    output.write(encode("live"));
    expect(terminal.options.disableStdin).toBe(true);
    expect(terminal.write).toHaveBeenCalledTimes(1);
    expect(terminal.reset).not.toHaveBeenCalled();
    callbacks.shift()!();
    expect(terminal.options.disableStdin).toBe(false);
    expect(terminal.reset).toHaveBeenCalledOnce();
    expect(terminal.write).toHaveBeenCalledTimes(2);
    callbacks.shift()!();
  });

  it("preserves an existing input lock and stops pending writes on disposal", () => {
    let finish: () => void = () => {};
    const terminal = {
      options: { disableStdin: true },
      write: vi.fn((_data: Uint8Array, callback: () => void) => { finish = callback; }),
      reset: vi.fn(),
    };
    const onWrite = vi.fn();
    const output = createTerminalOutput(terminal, onWrite);
    output.write(encode("history"), true);
    finish();
    expect(terminal.options.disableStdin).toBe(true);
    output.write(encode("next"), true);
    output.write(encode("pending"));
    output.dispose();
    finish();
    expect(terminal.write).toHaveBeenCalledTimes(2);
    expect(onWrite).toHaveBeenCalledOnce();
  });
});
