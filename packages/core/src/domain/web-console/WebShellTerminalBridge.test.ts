import { describe, expect, it } from "vitest";
import { WEB_SHELL_OPEN_TERMINAL_TYPE, readWebShellOpenTerminal, webShellTerminalUrl } from "./WebShellTerminalBridge";

describe("WebShellTerminalBridge", () => {
  it("opens the terminal on the selected gateway and preserves its port", () => {
    expect(webShellTerminalUrl("http://127.0.0.1:3100")).toBe("http://127.0.0.1:3100/web#new-terminal");
  });

  it("accepts terminal requests only from the embedded webapp frame", () => {
    const source = {} as MessageEventSource;
    expect(readWebShellOpenTerminal({
      data: { type: WEB_SHELL_OPEN_TERMINAL_TYPE }, origin: "https://agentroam.example", source,
    }, "https://agentroam.example", source)).toEqual({ type: WEB_SHELL_OPEN_TERMINAL_TYPE });
    expect(readWebShellOpenTerminal({
      data: { type: WEB_SHELL_OPEN_TERMINAL_TYPE }, origin: "https://other.example", source,
    }, "https://agentroam.example", source)).toBeNull();
    expect(readWebShellOpenTerminal({
      data: { type: WEB_SHELL_OPEN_TERMINAL_TYPE }, origin: "https://agentroam.example", source: {} as MessageEventSource,
    }, "https://agentroam.example", source)).toBeNull();
  });
});
