interface OutputTerminal {
  options: { disableStdin?: boolean };
  write: (data: Uint8Array, callback: () => void) => void;
  reset: () => void;
}

export function createTerminalOutput(terminal: OutputTerminal, onWrite: () => void) {
  const pending: Array<{ data: Uint8Array; replay: boolean } | null> = [];
  let writing = false;
  let disposed = false;

  const drain = () => {
    if (disposed || writing || pending.length === 0) return;
    const next = pending.shift()!;
    if (next === null) {
      terminal.reset();
      drain();
      return;
    }
    writing = true;
    const previousDisableStdin = terminal.options.disableStdin;
    if (next.replay) terminal.options.disableStdin = true;
    terminal.write(next.data, () => {
      if (disposed) return;
      if (next.replay) terminal.options.disableStdin = previousDisableStdin;
      writing = false;
      onWrite();
      drain();
    });
  };

  return {
    write(data: Uint8Array, replay = false) {
      if (disposed) return;
      pending.push({ data, replay });
      drain();
    },
    reset() {
      if (disposed) return;
      pending.push(null);
      drain();
    },
    dispose() {
      disposed = true;
      pending.length = 0;
    },
  };
}
