import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { LiveViewRegistry } from '../../../core/src/domain/live-view/live-view-registry';
// @ts-expect-error gateway ESM
import { RemoteAuthorization, isLocalAuthorizationRequest } from './remote-authorization.mjs';

function request(address = '127.0.0.1', headers = {}) { return { socket: { remoteAddress: address }, headers: { host: '127.0.0.1:3009', ...headers } }; }
describe('remote authorization local boundary', () => {
  it('accepts only direct local browser connections', () => {
    expect(isLocalAuthorizationRequest(request())).toBe(true);
    expect(isLocalAuthorizationRequest(request('::1', {host:'localhost:3009'}))).toBe(true);
    expect(isLocalAuthorizationRequest(request('192.168.1.3'))).toBe(false);
    expect(isLocalAuthorizationRequest(request('127.0.0.1', {host:'tunnel.example'}))).toBe(false);
    for (const header of ['x-forwarded-for', 'forwarded', 'cf-connecting-ip', 'x-real-ip']) expect(isLocalAuthorizationRequest(request('127.0.0.1', {[header]:'127.0.0.1'}))).toBe(false);
  });
});

async function fixture(options: Record<string, unknown> = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'remote-auth-'));
  let screen = false;
  const helper = { available: vi.fn(async () => true), start: vi.fn(async () => {}), stop: vi.fn(async () => {}), request: vi.fn(async (cmd: any) => {
    if (cmd.op === 'status') return {ok:true,screen,accessibility:true};
    if (cmd.op === 'capture') return {ok:true,data:Buffer.alloc(30,1).toString('base64'),width:1000,height:800,originX:0,originY:0};
    return {ok:true};
  }) };
  const registry = new LiveViewRegistry();
  const service = new RemoteAuthorization({dataDir, registry, userId:'owner', helper, supported:true, intervalMs:60000, ...options});
  await service.initialize();
  const frames: any[] = [];
  const viewer = { id:'phone', userId:'owner', producerSessionIds:new Set<string>(), watchedSessionId:null, send:(event:any)=>frames.push(event) };
  registry.connect(viewer);
  const watch = async (target = viewer) => {
    registry.watch(target, service.sessionId);
    await service.inputQueue;
    return registry.list(target)[0];
  };
  return {service,registry,viewer,frames,helper,watch,grant:()=>{screen=true;service.lastPermissionCheck=0;},close:async()=>{await service.close();await rm(dataDir,{recursive:true,force:true});}};
}

describe('CLI remote desktop', () => {
  it('rechecks permissions without enabling stopped sharing', async () => {
    const f = await fixture();
    try { f.grant(); const status = await f.service.action('recheck'); expect(status.screen).toBe(true); expect(status.enabled).toBe(false); expect(f.registry.list(f.viewer)).toEqual([]); expect(f.helper.stop).toHaveBeenCalled(); } finally { await f.close(); }
  });
  it('does not launch on status, waits for permission, publishes frames and supports existing phone takeover/input', async () => {
    const f = await fixture();
    try {
      expect((await f.service.status()).enabled).toBe(false); expect(f.helper.start).not.toHaveBeenCalled();
      await f.service.action('authorize','screen');
      expect(f.registry.list(f.viewer)[0]).toMatchObject({availability:'unavailable',viewerCount:0});
      expect(f.helper.request.mock.calls.some(([command]:any[])=>command.op==='capture')).toBe(false);
      f.grant(); const session = await f.watch(); expect(session.availability).toBe('ready');
      expect(f.frames.some(e=>e.type==='browser:frame')).toBe(true);
      f.registry.takeOver(f.viewer,session.id); await f.service.inputQueue;
      await f.registry.input(f.viewer,session.id,{kind:'pointer',action:'down',x:0.5,y:0.5,button:'left'}); await f.service.inputQueue;
      expect(f.helper.request).toHaveBeenCalledWith(expect.objectContaining({op:'down',x:500,y:400}));
      f.registry.returnControl(f.viewer,session.id); await f.service.inputQueue;
      expect(f.registry.list(f.viewer)[0].state).toBe('agent-controlled');
      await f.service.action('disable'); expect(f.registry.list(f.viewer)).toEqual([]);
    } finally { await f.close(); }
  });
  it('rejects unauthenticated and non-local authorization before launching native code', async () => {
    const f = await fixture();
    try {
      for (const headers of [{host:'localhost:3009'}, {host:'tunnel.example','x-agentroam-device-id':'paired'}]) {
        const req = Object.assign(Readable.from([JSON.stringify({action:'authorize',permission:'screen'})]), request('127.0.0.1',headers), {url:'/api/remote-authorization',method:'POST'});
        const res = {writeHead:vi.fn(),end:vi.fn()}; await f.service.handle(req,res);
        expect([401,403]).toContain(res.writeHead.mock.calls[0][0]);
      }
      expect(f.helper.start).not.toHaveBeenCalled();
    } finally { await f.close(); }
  });
  it('does not publish a late capture after stop', async () => {
    const f = await fixture();
    try {
      let finish!: (value:any)=>void; f.grant();
      f.helper.request.mockImplementation(async (cmd:any) => {
        if (cmd.op === 'status') return {ok:true,screen:true,accessibility:true};
        if (cmd.op === 'capture') return new Promise(resolve => { finish=resolve; });
        return {ok:true};
      });
      await f.service.action('enable');
      const start = f.watch();
      await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
      await f.service.action('disable');
      finish({data:Buffer.alloc(30).toString('base64'),width:100,height:100}); await start;
      expect(f.registry.list(f.viewer)).toEqual([]);
    } finally { await f.close(); }
  });
  it('applies return/takeover states immediately while media teardown is still in flight', async () => {
    const f = await fixture();
    let releaseVideoOff: (() => void) | undefined;
    try {
      f.grant();
      f.helper.request.mockImplementation(async (cmd:any) => {
        if (cmd.op === 'status') return {ok:true,screen:true,accessibility:true};
        if (cmd.op === 'video' && cmd.enabled === false) return new Promise<void>((resolve) => { releaseVideoOff = resolve; });
        if (cmd.op === 'capture') return {ok:true,data:Buffer.alloc(30,1).toString('base64'),width:1000,height:800,originX:0,originY:0};
        return {ok:true};
      });
      await f.service.action('enable');
      const sessionId = f.service.sessionId;
      await f.watch();
      f.registry.takeOver(f.viewer, sessionId); await f.service.inputQueue;
      expect(f.registry.list(f.viewer)[0].state).toBe('user-controlled');
      // The werift/helper teardown (video off) hangs below; neither the return
      // nor a fast re-takeover may inherit that delay.
      f.registry.returnControl(f.viewer, sessionId); await f.service.inputQueue;
      expect(f.registry.list(f.viewer)[0].state).toBe('agent-controlled');
      f.registry.takeOver(f.viewer, sessionId); await f.service.inputQueue;
      expect(f.registry.list(f.viewer)[0].state).toBe('user-controlled');
    } finally {
      releaseVideoOff?.();
      await f.close();
    }
  });
});

it('uses the real pairing gateway: rejects spoofed, forwarded and revoked devices', async () => {
  const { createServer } = await import('node:http');
  const { DevicePairingStore } = await import('../device-pairing-store.mjs');
  const { createDevicePairingGateway } = await import('../device-pairing-gateway.mjs');
  const f = await fixture();
  const store = new DevicePairingStore(f.service.dataDir);
  const gateway = createDevicePairingGateway({ dataDir:f.service.dataDir, store, desktop:{authenticate:()=>false}, owner:{userId:'owner',username:'local'}, consoleStore:{} });
  const server = createServer((req,res)=>{ void gateway.handle(req,res).then(async handled=>{if(!handled) await f.service.handle(req,res);}); });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    expect((await fetch(`${base}/api/remote-authorization`,{headers:{'x-agentroam-device-id':'spoof'}})).status).toBe(401);
    const pending = store.exchange(store.createCode().code,'Computer');
    store.decide(pending.request.id,pending.request.phrase,true);
    const paired = store.poll(pending.claimToken);
    const headers = {cookie:`agentroam_device_session=${paired.token}`};
    expect((await fetch(`${base}/api/remote-authorization`,{headers})).status).toBe(200);
    expect((await fetch(`${base}/api/remote-authorization`,{headers:{...headers,'x-forwarded-for':'127.0.0.1'}})).status).toBe(403);
    const remoteHeaders = {...headers, 'x-forwarded-for':'192.168.1.10'};
    const remoteStatus = await fetch(`${base}/api/remote-authorization/status`, {headers: remoteHeaders});
    expect(remoteStatus.status).toBe(200);
    expect(await remoteStatus.json()).toMatchObject({local:false, enabled:false, screen:false, online:false});
    expect((await fetch(`${base}/api/remote-authorization/status`, {method:'POST', headers:{...remoteHeaders, origin:base}})).status).toBe(405);
    expect((await fetch(`${base}/api/remote-authorization/status`, {headers:{'x-agentroam-device-id':'spoof'}})).status).toBe(401);
    expect(f.helper.start).not.toHaveBeenCalled();
    store.revoke(paired.device.id);
    expect((await fetch(`${base}/api/remote-authorization/status`, {headers:remoteHeaders})).status).toBe(401);
    expect((await fetch(`${base}/api/remote-authorization`,{headers})).status).toBe(401);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); gateway.close(); await f.close(); }
});

it('switches the video source and maps input to the selected display without replacing the peer', async () => {
  const f = await fixture();
  let selected = '1';
  const displays = () => [{id:'1',label:'第 1 屏',primary:true,selected:selected==='1'},{id:'2',label:'第 2 屏',primary:false,selected:selected==='2'}];
  const frame = () => ({data:Buffer.alloc(30,1).toString('base64'),width:selected==='1'?1000:1600,height:900,originX:selected==='1'?0:-1600,originY:-100,displays:displays()});
  f.helper.request.mockImplementation(async(cmd:any)=>{
    if(cmd.op==='status') return {screen:true,accessibility:true};
    if(cmd.op==='set-display') {selected=cmd.displayId;return frame();}
    if(cmd.op==='capture') return frame();
    return {ok:true};
  });
  const peer={};f.service.video.peer=peer;f.service.video.connected=true;
  const pause=vi.spyOn(f.service.video,'pause');const resume=vi.spyOn(f.service.video,'resume');
  try {
    f.grant();await f.service.action('enable');
    await f.watch();
    expect(f.registry.list(f.viewer)[0].displays?.[0].selected).toBe(true);
    f.registry.takeOver(f.viewer,f.service.sessionId);await f.service.inputQueue;
    f.registry.setDisplay(f.viewer,f.service.sessionId,'2');await f.service.inputQueue;
    expect(f.registry.list(f.viewer)[0].displays?.[1].selected).toBe(true);
    expect(f.registry.list(f.viewer)[0].state).toBe('user-controlled');
    expect(f.service.video.peer).toBe(peer);expect(pause).toHaveBeenCalledOnce();expect(resume).toHaveBeenCalledOnce();
    expect(f.helper.request).toHaveBeenCalledWith({op:'video',enabled:true});
    await f.registry.input(f.viewer,f.service.sessionId,{kind:'pointer',action:'move',x:0.5,y:0.5});await f.service.inputQueue;
    expect(f.helper.request).toHaveBeenCalledWith({op:'move',x:-800,y:350,button:'left',click:1});
    expect(()=>f.registry.setDisplay(f.viewer,f.service.sessionId,'missing')).toThrow('unknown display');
  } finally {f.service.video.peer=null;await f.close();}
});

it('discards a capture and input queued for the old screen while switching',async()=>{
  const f=await fixture();let finish:any;let slow=false;
  const displays=[{id:'1',label:'one',selected:true,primary:true},{id:'2',label:'two',selected:false,primary:false}];
  const frame={data:Buffer.alloc(30).toString('base64'),width:100,height:100,originX:0,originY:0,displays};
  f.helper.request.mockImplementation(async(cmd:any)=>{
    if(cmd.op==='status')return{screen:true,accessibility:true};
    if(cmd.op==='capture'&&slow)return new Promise(resolve=>{finish=resolve;});
    if(cmd.op==='set-display')return{...frame,originX:100,displays:displays.map(d=>({...d,selected:d.id==='2'}))};
    return frame;
  });
  try{
    f.grant();await f.service.action('enable');await f.watch();f.registry.takeOver(f.viewer,f.service.sessionId);await f.service.inputQueue;
    slow=true;const tick=f.service.tick();await vi.waitFor(()=>expect(finish).toBeTypeOf('function'));
    f.registry.setDisplay(f.viewer,f.service.sessionId,'2');
    const input=f.registry.input(f.viewer,f.service.sessionId,{kind:'pointer',action:'down',x:0,y:0});
    const before=f.service.sequence;finish(frame);await tick;await f.service.inputQueue;
    expect(f.service.sequence).toBe(before+1);
    await input;expect(f.service.error).toContain('屏幕正在切换');
    expect(f.helper.request.mock.calls.some(([cmd]:any)=>cmd.op==='down')).toBe(false);
    expect(f.service.bounds.originX).toBe(100);
  }finally{await f.close();}
});

it('changes quality on the selected display, acknowledges the applied profile, and preserves the stream',async()=>{
  const f=await fixture();let quality='hd';let reject=false;
  const displays=[{id:'1',label:'one',selected:false,primary:true},{id:'2',label:'two',selected:true,primary:false}];
  f.helper.request.mockImplementation(async(cmd:any)=>{
    if(cmd.op==='status')return{screen:true,accessibility:true};
    if(cmd.op==='set-quality') {if(reject)throw new Error('编码器不可用');quality=cmd.quality;}
    return{data:Buffer.alloc(30).toString('base64'),width:1440,height:900,originX:-1440,originY:0,displays,quality};
  });
  const peer={};f.service.video.peer=peer;f.service.video.connected=true;
  try{
    f.grant();await f.service.action('enable');await f.watch();expect(f.service.quality).toBe('hd');
    f.registry.takeOver(f.viewer,f.service.sessionId);await f.service.inputQueue;
    for(const next of ['smooth','original','hd']){
      f.registry.webrtcFromViewer(f.viewer,f.service.sessionId,{kind:'quality',quality:next});await f.service.inputQueue;
      expect(f.service.quality).toBe(next);expect(f.service.video.peer).toBe(peer);
      expect(f.frames.at(-1)).toMatchObject({type:'browser:webrtc',data:{kind:'quality-state',quality:next}});
      expect(f.service.bounds.originX).toBe(-1440);expect(f.service.displays[1].selected).toBe(true);
    }
    await expect(f.service.setQuality('invalid')).rejects.toThrow('未知画质');
    reject=true;f.registry.webrtcFromViewer(f.viewer,f.service.sessionId,{kind:'quality',quality:'original'});await f.service.inputQueue;
    expect(f.frames.at(-1).data).toMatchObject({quality:'hd',error:'编码器不可用'});
    expect(f.service.switching).toBe(false);
  }finally{f.service.video.peer=null;await f.close();}
});

it('supports only the shipped Windows x64 and macOS arm64 versions', async () => {
  const { supportsRemoteDesktop } = await import('./remote-authorization.mjs');
  expect(supportsRemoteDesktop('win32','x64','10.0.22631')).toBe(true);
  expect(supportsRemoteDesktop('win32','x64','6.3.9600')).toBe(false);
  expect(supportsRemoteDesktop('win32','arm64','10.0.22631')).toBe(false);
  expect(supportsRemoteDesktop('darwin','arm64','23.0.0')).toBe(true);
  expect(supportsRemoteDesktop('darwin','x64','23.0.0')).toBe(false);
  expect(supportsRemoteDesktop('linux','x64','6.10.0')).toBe(false);
});

it('uses explicit Windows sharing and releases input when a viewer disconnects or the desktop locks', async () => {
  const f = await fixture(); f.service.platform = 'win32';
  try {
    await expect(f.service.action('authorize','screen')).rejects.toThrow('直接点击开启共享');
    expect(f.helper.start).not.toHaveBeenCalled();
    f.grant(); await f.service.action('enable');
    expect(await f.service.status()).toMatchObject({platform:'win32',enabled:true,online:true});
    await f.watch(); f.registry.takeOver(f.viewer,f.service.sessionId); await f.service.inputQueue;
    f.registry.disconnect(f.viewer); await f.service.inputQueue;
    expect(f.helper.request).toHaveBeenCalledWith({op:'release'});
    const secondViewer = { id:'phone-2', userId:'owner', producerSessionIds:new Set<string>(), watchedSessionId:null, send:vi.fn() };
    f.registry.connect(secondViewer); await f.watch(secondViewer);
    f.service.lastPermissionCheck=0;
    f.helper.request.mockImplementation(async (cmd:any) => cmd.op==='status' ? {screen:false,accessibility:false,error:'Windows locked'} : {ok:true});
    await f.service.tick();
    expect(await f.service.status()).toMatchObject({screen:false,online:true,error:'Windows locked'});
    expect(f.registry.list(f.viewer)[0]).toMatchObject({availability:'unavailable',platform:'win32'});
    expect(f.service.bounds).toBeNull();
  } finally {await f.close();}
});

it('keeps a Windows session visible when sharing starts while locked and validates system action targets', async () => {
  const system = {
    probe: vi.fn(async () => ({available:true,locked:true})),
    wake: vi.fn(async () => ({ok:true,woke:true})),
    unlock: vi.fn(async () => ({ok:true})),
  };
  const f = await fixture({platform:'win32',system});
  f.helper.request.mockImplementation(async (cmd:any) => {
    if (cmd.op === 'status') return {ok:true,screen:false,accessibility:false,locked:true,error:'Windows 已锁屏'};
    return {ok:true};
  });
  try {
    await f.service.action('enable');
    expect(f.registry.list(f.viewer)[0]).toMatchObject({
      id:f.service.sessionId, platform:'win32', online:true, availability:'unavailable', capabilityErrorCode:'desktop-locked',
    });
    expect(await f.service.status()).toMatchObject({online:true,locked:true,unlock:'available'});
    await expect(f.service.systemAction('wake',{sessionId:'stale'})).rejects.toThrow('会话已失效');
    await expect(f.service.systemAction('wake',{sessionId:f.service.sessionId})).resolves.toMatchObject({ok:true});
    expect(system.wake).toHaveBeenCalledOnce();
    await f.service.systemAction('unlock',{sessionId:f.service.sessionId,password:'123456'});
    expect(system.unlock).toHaveBeenCalledWith('123456');
    await f.service.systemAction('lock',{sessionId:f.service.sessionId});
    expect(f.helper.request).toHaveBeenCalledWith({op:'lock'});
  } finally { await f.close(); }
});

it('invalidates Windows input coordinates and releases held input when capture fails', async () => {
  const f=await fixture();f.service.platform='win32';
  try {
    f.grant();await f.service.action('enable');await f.watch();expect(f.service.bounds).not.toBeNull();
    f.helper.request.mockImplementation(async(cmd:any)=>{if(cmd.op==='capture')throw new Error('DXGI access lost');return {ok:true,screen:true,accessibility:true};});
    await f.service.tick();
    expect(f.service.bounds).toBeNull();
    expect(f.helper.request).toHaveBeenCalledWith({op:'release'});
    expect(await f.service.status()).toMatchObject({online:true,error:'DXGI access lost'});
  } finally {await f.close();}
});

it('stops capture three seconds after the last viewer leaves and cancels the stop on reconnect', async () => {
  const f = await fixture({idleDelayMs:20});
  try {
    f.grant(); await f.service.action('enable'); await f.watch();
    const captureCalls = () => f.helper.request.mock.calls.filter(([command]:any[]) => command.op === 'capture').length;
    expect(captureCalls()).toBeGreaterThan(0);

    f.registry.unwatch(f.viewer); await f.service.inputQueue;
    await new Promise((resolve) => setTimeout(resolve, 5));
    await f.watch();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(f.helper.request.mock.calls.some(([command]:any[]) => command.op === 'stop-capture')).toBe(false);

    f.registry.unwatch(f.viewer); await f.service.inputQueue;
    await vi.waitFor(() => expect(f.helper.request.mock.calls.some(([command]:any[]) => command.op === 'stop-capture')).toBe(true));
    expect(f.helper.stop).toHaveBeenCalled();
    expect(f.registry.list(f.viewer)[0]).toMatchObject({availability:'starting',viewerCount:0});
  } finally { await f.close(); }
});

it('keeps capture active until the final phone stops watching', async () => {
  const f = await fixture({idleDelayMs:10});
  const secondViewer = { id:'phone-2', userId:'owner', producerSessionIds:new Set<string>(), watchedSessionId:null, send:vi.fn() };
  f.registry.connect(secondViewer);
  try {
    f.grant(); await f.service.action('enable'); await f.watch(); await f.watch(secondViewer);
    f.helper.request.mockClear(); f.helper.stop.mockClear();
    f.registry.unwatch(f.viewer); await f.service.inputQueue;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(f.helper.stop).not.toHaveBeenCalled();

    f.registry.unwatch(secondViewer); await f.service.inputQueue;
    await vi.waitFor(() => expect(f.helper.stop).toHaveBeenCalled());
    expect(f.helper.request).toHaveBeenCalledWith({op:'stop-capture'});
  } finally { await f.close(); }
});

it('waits for owned capture and helper shutdown when the service closes', async () => {
  const f = await fixture();
  f.grant(); await f.service.action('enable'); await f.watch();
  f.helper.request.mockClear(); f.helper.stop.mockClear();
  await f.close();
  expect(f.helper.request).toHaveBeenCalledWith({op:'stop-capture'});
  expect(f.helper.stop).toHaveBeenCalledOnce();
});

it('closes the owned helper before waiting for stalled media teardown', async () => {
  const f = await fixture();
  f.grant(); await f.service.action('enable'); await f.watch();
  let releaseVideo!: () => void;
  vi.spyOn(f.service.video, 'stop').mockImplementation(() => new Promise<void>((resolve) => { releaseVideo = resolve; }));
  f.helper.stop.mockClear();
  f.helper.stop.mockImplementation(async () => { releaseVideo(); });
  await f.close();
  expect(f.helper.stop).toHaveBeenCalledOnce();
});
