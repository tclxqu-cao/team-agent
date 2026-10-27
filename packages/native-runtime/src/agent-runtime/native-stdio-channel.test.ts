import { describe, expect, it, vi } from "vitest";
import { NativeStdioChannel, type NativeJsonPacket } from "./native-stdio-channel.js";

const inputLoop = `const {createInterface}=require('node:readline');const lines=createInterface({input:process.stdin});const reply=(v)=>process.stdout.write(JSON.stringify(v)+'\\n');`;
const responseKey = (packet: NativeJsonPacket) => "result" in packet || "error" in packet ? String(packet.id) : undefined;
function channel(script: string, options: Partial<ConstructorParameters<typeof NativeStdioChannel>[0]> = {}) {
  return new NativeStdioChannel({ command: process.execPath, args: ["-e", script], responseKey, requestTimeoutMs: 2_000, ...options });
}

describe("native stdio channel", () => {
  it("decodes fragmented UTF-8, CRLF and an unterminated final packet", async () => {
    const cli = channel(`${inputLoop}lines.on('line',line=>{const v=JSON.parse(line);const body=Buffer.from(JSON.stringify({id:v.id,result:'\\u4f1a\\u8bdd'}));process.stdout.write('\\r\\n');process.stdout.write(body.subarray(0,20));setTimeout(()=>process.stdout.end(body.subarray(20)),5);});`);
    try { expect(await cli.request("1", { id: 1 })).toEqual({ id: 1, result: "会话" }); }
    finally { await cli.dispose(); }
  });

  it("correlates concurrent replies independently of notification order", async () => {
    const onPacket = vi.fn();
    const cli = channel(`${inputLoop}lines.on('line',line=>{const v=JSON.parse(line);reply({method:'notice',params:{id:v.id}});setTimeout(()=>reply({id:v.id,result:v.id}),v.id===1?30:0);});`, { onPacket });
    try {
      expect(await Promise.all([cli.request("1", { id: 1 }), cli.request("2", { id: 2 })])).toEqual([{ id: 1, result: 1 }, { id: 2, result: 2 }]);
      expect(onPacket).toHaveBeenCalledTimes(2);
    } finally { await cli.dispose(); }
  });

  it("does not confuse reverse requests with replies using the same numeric ID", async () => {
    let cli: NativeStdioChannel;
    cli = channel(`${inputLoop}lines.on('line',line=>{const v=JSON.parse(line);if(v.method)reply({id:1,method:'permission'});else reply({id:1,result:{allowed:v.result.allowed}});});`, {
      onPacket: async packet => { await cli.send({ id: packet.id, result: { allowed: false } }); },
    });
    try { expect(await cli.request("1", { id: 1, method: "prompt" })).toEqual({ id: 1, result: { allowed: false } }); }
    finally { await cli.dispose(); }
  });

  it("supports WorkBuddy's observed nested request ID without embedding its protocol", async () => {
    const cli = channel(`${inputLoop}lines.on('line',line=>{const v=JSON.parse(line);reply({type:'control_response',response:{subtype:'success',request_id:v.request_id,response:{models:[]}}});});`, {
      responseKey: packet => packet.type === "control_response" ? String((packet.response as NativeJsonPacket).request_id) : undefined,
    });
    try {
      expect(await cli.request("initialize-1", { type: "control_request", request_id: "initialize-1", request: { subtype: "initialize" } })).toMatchObject({ response: { request_id: "initialize-1", subtype: "success" } });
    } finally { await cli.dispose(); }
  });

  it("times out only the waiting request and keeps the same live process", async () => {
    const cli = channel(`${inputLoop}lines.on('line',line=>{const v=JSON.parse(line);if(v.method!=='hang')reply({id:v.id,result:process.pid});});`);
    try {
      const before = await cli.request("before", { id: "before" });
      await expect(cli.request("hang", { id: "hang", method: "hang" }, 20)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: expect.stringContaining("timed out") });
      const after = await cli.request("after", { id: "after" });
      expect(after.result).toBe(before.result);
    } finally { await cli.dispose(); }
  });

  it("rejects pending requests on process exit without silently respawning", async () => {
    const onFailure = vi.fn();
    const cli = channel(`${inputLoop}lines.on('line',()=>process.exit(7));`, { onFailure });
    await expect(cli.request("1", { id: 1 })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    await expect(cli.request("2", { id: 2 })).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(onFailure).toHaveBeenCalledTimes(1);
    await cli.dispose();
  });

  it.each(["not-json-private-content", "[]", "42"])("fails closed on malformed output %s without exposing payloads", async line => {
    const cli = channel(`${inputLoop}lines.on('line',()=>process.stdout.write(${JSON.stringify(line)}+'\\n'));`);
    try {
      await expect(cli.request("1", { id: 1 })).rejects.toMatchObject({ code: "NATIVE_PROTOCOL_ERROR", message: "Native CLI sent an invalid JSON packet" });
    } finally { await cli.dispose(); }
  });

  it("bounds partial lines and outbound requests", async () => {
    const cli = channel(`${inputLoop}lines.on('line',()=>process.stdout.write('x'.repeat(128)));`, { maxLineBytes: 64 });
    try {
      await expect(cli.send({ content: "x".repeat(128) })).rejects.toMatchObject({ code: "NATIVE_PROTOCOL_ERROR" });
      await expect(cli.request("1", { id: 1 })).rejects.toMatchObject({ code: "NATIVE_PROTOCOL_ERROR" });
    } finally { await cli.dispose(); }
  });

  it("bounds request concurrency and rejects duplicate request IDs", async () => {
    const cli = channel(`${inputLoop}lines.on('line',()=>{});`, { maxPendingRequests: 1 });
    const pending = cli.request("held", { id: "held" }).catch(error => error);
    try {
      await new Promise(resolve => setTimeout(resolve, 30));
      await expect(cli.request("held", { id: "held" })).rejects.toMatchObject({ code: "NATIVE_PROTOCOL_ERROR" });
      await expect(cli.request("second", { id: "second" })).rejects.toMatchObject({ code: "NATIVE_PROTOCOL_ERROR" });
    } finally { await cli.dispose(); }
    expect(await pending).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });

  it("disposes idempotently and kills only its owned child after the shutdown grace", async () => {
    const cli = channel(`${inputLoop}process.on('SIGTERM',()=>{});lines.on('line',line=>{const v=JSON.parse(line);if(v.method==='ready')reply({id:v.id,result:process.pid});});setInterval(()=>{},1000);`, { shutdownGraceMs: 20 });
    const ready = await cli.request("ready", { id: "ready", method: "ready" });
    const pending = cli.request("hang", { id: "hang" }).catch(error => error);
    await new Promise(resolve => setTimeout(resolve, 10));
    const disposal = cli.dispose();
    expect(cli.dispose()).toBe(disposal);
    await disposal;
    expect(await pending).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(() => process.kill(ready.result as number, 0)).toThrow();
  });
});
