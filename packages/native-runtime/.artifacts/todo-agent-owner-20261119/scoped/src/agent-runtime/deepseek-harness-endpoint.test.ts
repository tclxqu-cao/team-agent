import { describe, expect, it, vi } from "vitest";
import { discoverHarnessEndpoint, selectHarnessListenerOrigins, selectHarnessProcesses } from "./deepseek-harness-endpoint.js";

const processes = [
  "101 501 /usr/bin/node /pkg/@deepseek-ai/dsh/lib/bin.js web --port 3080",
  "202 501 /Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness --expose-internals /pkg/@deepseek-ai/dsh-desktop-host/lib/index.js /pkg /home/.dsh/profiles/desktop",
  "303 502 /usr/bin/node /pkg/@deepseek-ai/dsh/lib/bin.js web",
  "404 501 /bin/sh -c echo /pkg/@deepseek-ai/dsh-desktop-host/lib/index.js",
  "505 501 /usr/bin/node /pkg/@deepseek-ai/dsh/lib/bin.js headless",
].join("\n");

function fixture(acceptPort = "9020") {
  const execute = vi.fn(async (command: string, args: string[]) => ({ stdout: command.endsWith("ps") ? processes
    : args.includes("202") ? "p202\nn127.0.0.1:19387\nn127.0.0.1:9020\n" : "p101\nn127.0.0.1:3080\n" }));
  const readCookie = vi.fn(async () => "dsh-auth-fixture=cookie");
  const request = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const envelope = JSON.parse(String(init?.body));
    expect(init?.redirect).toBe("manual");
    expect(init?.headers).toMatchObject({ cookie: "dsh-auth-fixture=cookie" });
    expect(envelope).toMatchObject({ method: "session/list", payload: { args: { _request: {} } } });
    return new Response(new URL(String(url)).port === acceptPort
      ? JSON.stringify({ type: "server-response", rpcId: envelope.rpcId, result: { ok: true, value: { items: [] } } }) : "unrelated listener", { status: new URL(String(url)).port === acceptPort ? 200 : 404 });
  });
  return { platform: "darwin" as const, uid: 501, execute, readCookie, request: request as typeof fetch };
}

describe("Harness existing-host discovery", () => {
  it("selects current-user native Hosts, prioritizing desktop and excluding shell lookalikes", () => {
    expect(selectHarnessProcesses(processes, 501)).toEqual([{ pid: 202, kind: "desktop" }, { pid: 101, kind: "web" }]);
    expect(selectHarnessProcesses("7 501 /opt/homebrew/bin/dsh --profile desktop --no-open", 501)).toEqual([{ pid: 7, kind: "desktop" }]);
  });

  it("recognizes the bundled launcher's Resources/../MacOS executable path", () => {
    const command = "301 501 /Applications/DeepSeek Harness.app/Contents/Resources/../MacOS/DeepSeek Harness --expose-internals /Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js web --host 127.0.0.1 --port 0 --no-open";
    expect(selectHarnessProcesses(command, 501)).toEqual([{ pid: 301, kind: "web" }]);
  });

  it("requires a loopback listener belonging to the selected process", () => {
    expect(selectHarnessListenerOrigins("p99\nn127.0.0.1:8888\np202\nn*:9000\nn10.0.0.1:9000\nn[::1]:9020\nn127.0.0.1:9021\nn127.0.0.1:70000", 202))
      .toEqual(["http://[::1]:9020", "http://127.0.0.1:9021"]);
  });

  it("borrows desktop only after authenticating and checking the native RPC response", async () => {
    const options = fixture();
    expect(await discoverHarnessEndpoint(options)).toMatchObject({ origin: "http://127.0.0.1:9020", cookie: "dsh-auth-fixture=cookie" });
    expect(options.request).toHaveBeenCalledTimes(2);
    expect(options.execute.mock.calls.every(([, args]) => !args.includes("303"))).toBe(true);
  });

  it("uses an existing Web host when desktop listeners cannot serve compatible RPCs", async () => {
    expect(await discoverHarnessEndpoint(fixture("3080"))).toMatchObject({ origin: "http://127.0.0.1:3080" });
  });

  it("never returns the owned Web host when probing for a late desktop", async () => {
    const options = fixture("3080");
    expect(await discoverHarnessEndpoint({ ...options, desktopOnly: true })).toBeNull();
    expect(options.execute.mock.calls.some(([, args]) => args.includes("101"))).toBe(false);
  });

  it("does not send requests without local authentication or follow HTTP redirects", async () => {
    const options = fixture();
    options.readCookie.mockResolvedValue(null as unknown as string);
    expect(await discoverHarnessEndpoint(options)).toBeNull();
    expect(options.request).not.toHaveBeenCalled();
    const redirect = fixture();
    redirect.request = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://external.example" } })) as unknown as typeof fetch;
    expect(await discoverHarnessEndpoint(redirect)).toBeNull();
  });

  it("ignores exited processes, mismatched RPC identifiers, and unavailable discovery tools", async () => {
    const options = fixture();
    options.execute.mockImplementation(async command => {
      if (command.endsWith("ps")) return { stdout: processes };
      throw new Error("process exited");
    });
    expect(await discoverHarnessEndpoint(options)).toBeNull();
    const mismatched = fixture();
    mismatched.request = vi.fn(async () => Response.json({ type: "server-response", rpcId: "wrong", result: { ok: true, value: { items: [] } } })) as unknown as typeof fetch;
    expect(await discoverHarnessEndpoint(mismatched)).toBeNull();
    expect(await discoverHarnessEndpoint({ ...fixture(), execute: async () => { throw new Error("missing tools"); } })).toBeNull();
  });

  it("accepts the same owner-filtered Windows snapshot with desktop priority", async () => {
    const options = fixture();
    const execute = vi.fn(async () => ({ stdout: JSON.stringify([
      { pid: 101, command: '"C:\\Program Files\\nodejs\\node.exe" C:\\pkg\\@deepseek-ai\\dsh\\lib\\bin.js web', ports: [{ LocalAddress: "127.0.0.1", LocalPort: 3080 }] },
      { pid: 202, command: '"C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe" C:\\pkg\\@deepseek-ai\\dsh-desktop-host\\lib\\index.js', ports: [{ LocalAddress: "127.0.0.1", LocalPort: 9020 }] },
    ]) }));
    expect(await discoverHarnessEndpoint({ ...options, platform: "win32", execute })).toMatchObject({ origin: "http://127.0.0.1:9020" });
    expect(execute.mock.calls).toHaveLength(1);
  });
});
