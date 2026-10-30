import { describe, expect, it } from "vitest";
import { NativeRpcClient } from "./native-rpc-client.js";

const fixture = `
const {createInterface}=require('node:readline');
const send=p=>process.stdout.write(JSON.stringify(p)+'\\n');
let pending;
createInterface({input:process.stdin}).on('line',line=>{
 const p=JSON.parse(line);
 if(p.method==='strict-zcode') {
  if('jsonrpc' in p)send({id:p.id,error:{code:-32600,message:'Unexpected JSON-RPC field'}});
  else send({id:p.id,result:{strict:true}});
 } else if(p.method==='crash') process.exit(9);
 else if(p.method==='reverse') {
  pending=p;send({id:p.id,method:'native/permission',params:{tool:'Write'}});
 } else if(p.method==='error')send({id:p.id,error:{code:-32000,message:'native failure'}});
 else if(!p.method&&pending) {
  send({id:pending.id,result:{callbackResult:p.result,callbackError:p.error,jsonrpc:pending.jsonrpc}});pending=null;
 }
});`;
const connection = (jsonrpc = true) => new NativeRpcClient(async () => ({ command: process.execPath, args: ["-e", fixture] }), jsonrpc);

describe("native RPC envelopes", () => {
  it("omits the JSON-RPC marker for ZCode's strict wire schema", async () => {
    const client = connection(false);
    try { expect(await client.request("strict-zcode", {})).toEqual({ strict: true }); }
    finally { await client.dispose(); }
  });
  it("keeps reverse requests distinct from replies even when native IDs collide", async () => {
    const client = connection();
    client.onRequest(async (method, params) => { expect(method).toBe("native/permission"); expect(params).toEqual({ tool: "Write" }); return { decision: "deny" }; });
    try { expect(await client.request("reverse", {})).toEqual({ callbackResult: { decision: "deny" }, jsonrpc: "2.0" }); }
    finally { await client.dispose(); }
  });
  it("rejects unsupported callbacks explicitly instead of silently approving", async () => {
    const client = connection();
    try { expect(await client.request("reverse", {})).toMatchObject({ callbackError: { code: -32601 } }); }
    finally { await client.dispose(); }
  });
  it("preserves native errors and closes idempotently", async () => {
    const client = connection();
    await expect(client.request("error", {})).rejects.toMatchObject({ code: "NATIVE_PROTOCOL_ERROR", nativeCode: -32000, message: "native failure" });
    await Promise.all([client.dispose(), client.dispose()]);
    await expect(client.request("error", {})).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
  });
  it("reconnects only on the next operation after the failed owned process has closed", async () => {
    const client = connection(false);
    try {
      await expect(client.request("crash", {})).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
      expect(await client.request("strict-zcode", {})).toEqual({ strict: true });
    } finally { await client.dispose(); }
  });
});
