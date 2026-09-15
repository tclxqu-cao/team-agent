import { afterEach, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { WindowsRemoteHelper } from './windows-helper.mjs';

const helpers: WindowsRemoteHelper[] = [];
afterEach(async () => { await Promise.all(helpers.splice(0).map(helper => helper.stop())); });
function fixture(script: string) {
  const children: ReturnType<typeof spawn>[] = [];
  const launch = vi.fn((_exe, _args, options) => {
    const child = spawn(process.execPath, ['-e', script], options);
    children.push(child); return child;
  });
  const helper = new WindowsRemoteHelper({ executable: process.execPath, launch });
  helpers.push(helper); return { helper, launch, children };
}
const echo = `require('readline').createInterface({input:process.stdin}).on('line',line=>{const c=JSON.parse(line);console.log(JSON.stringify({...c,ok:true,screen:true,accessibility:true}));}).on('close',()=>process.exit(0));`;

it('uses inherited pipes, probes status, routes requests and permits restart after EOF shutdown', async () => {
  const { helper, launch, children } = fixture(echo);
  await helper.start();
  expect(launch).toHaveBeenCalledWith(process.execPath, ['--parent', String(process.pid)], {stdio:['pipe','pipe','pipe'],windowsHide:true});
  expect(await helper.request({op:'set-display',displayId:'display2'})).toMatchObject({ok:true,displayId:'display2'});
  await helper.stop();
  expect(children[0].exitCode).toBe(0);
  await helper.start(); expect(children).toHaveLength(2);
});

it('cancels an unresolved startup immediately and can retry', async () => {
  const { helper, launch } = fixture('process.stdin.resume();process.stdin.on("end",()=>process.exit(0));');
  const start = helper.start(); const cancelled = expect(start).rejects.toThrow('取消');
  await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
  await helper.stop(); await cancelled;
  expect(helper.pending.size).toBe(0); expect(helper.starting).toBeNull();
});

it('rejects pending commands on a crash instead of accepting stale responses', async () => {
  const { helper } = fixture(`require('readline').createInterface({input:process.stdin}).on('line',line=>{const c=JSON.parse(line);if(c.op==='status')console.log(JSON.stringify({id:c.id,ok:true}));else process.exit(7);});`);
  await helper.start(); await expect(helper.request({op:'capture'})).rejects.toThrow('退出');
  expect(helper.pending.size).toBe(0);
});

it('delivers large IDR frames and encoder failure separately from request replies', async () => {
  const { helper } = fixture(`require('readline').createInterface({input:process.stdin}).on('line',line=>{const c=JSON.parse(line);console.log(JSON.stringify({id:c.id,ok:true}));if(c.op==='video'){console.log(JSON.stringify({event:'video',timestamp:1,nals:['A'.repeat(2500000)]}));console.log(JSON.stringify({event:'video-error',error:'encoder unavailable'}));}}).on('close',()=>process.exit(0));`);
  const receive = vi.fn(); helper.onVideo(receive);
  await helper.start(); await helper.request({op:'video',enabled:true});
  await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(2));
  expect(receive.mock.calls[0][0].nals[0]).toHaveLength(2500000);
  expect(receive.mock.calls[1][0]).toEqual({error:'encoder unavailable'});
});

it('bounds both outgoing commands and unterminated incoming messages', async () => {
  const { helper } = fixture(`require('readline').createInterface({input:process.stdin}).on('line',line=>{const c=JSON.parse(line);if(c.op==='status')console.log(JSON.stringify({id:c.id,ok:true}));else process.stdout.write('x'.repeat(8*1024*1024+1));});`);
  await helper.start();
  await expect(helper.request({op:'text',text:'x'.repeat(65536)})).rejects.toThrow('过大');
  await expect(helper.request({op:'capture'})).rejects.toThrow('过大');
  expect(helper.child).toBeNull();
});
