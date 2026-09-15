import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { WindowsRemoteHelper } from '../packages/server/lib/remote-control/windows-helper.mjs';

if (process.platform !== 'win32') throw new Error('Run this verification on Windows x64');
const index = process.argv.indexOf('--helper');
const executable = resolve(index < 0 ? 'packages/server/native/.build-remote/windows/agentroam-remote-desktop.exe' : process.argv[index + 1]);
execFileSync(executable, ['--self-test'], { stdio: 'inherit', timeout: 30_000 });
if (!process.argv.includes('--interactive')) {
  console.log('Synthetic encoder verified. Desktop capture/input not tested; use --interactive from a logged-in Windows terminal.');
} else {
  const helper = new WindowsRemoteHelper({ executable });
  try {
    await helper.start();
    const status = await helper.request({op:'status'});
    assert.equal(status.screen,true,'Unlock Windows and dismiss UAC before interactive verification');
    assert.equal(status.accessibility,true);
    const initial = await helper.request({op:'capture'});
    const jpeg = Buffer.from(initial.data,'base64');
    assert.equal(jpeg.readUInt16BE(0),0xffd8);
    assert(initial.width>0 && initial.height>0 && initial.displays.length>0);
    for (const display of initial.displays) {
      const frame=await helper.request({op:'set-display',displayId:display.id});
      assert.equal(frame.displayId,display.id);
      assert(frame.displays.some(d=>d.id===display.id && d.selected));
    }
    await helper.request({op:'set-display',displayId:initial.displayId});
    for (const quality of ['smooth','hd','original']) {
      assert.equal((await helper.request({op:'set-quality',quality})).quality,quality);
    }
    await helper.request({op:'set-quality',quality:'smooth'});
    const video = new Promise((resolveVideo,reject) => {
      const timer=setTimeout(()=>{unsubscribe();reject(new Error('No H264 frame in 12 seconds'));},12000);
      const unsubscribe=helper.onVideo(event=>{clearTimeout(timer);unsubscribe();event.error?reject(new Error(event.error)):resolveVideo(event);});
    });
    // Attach rejection handling before starting the encoder.
    const received=Promise.all([video,helper.request({op:'video',enabled:true})]);
    const [event]=await received;
    assert(event.nals.some(nal=>(Buffer.from(nal,'base64')[0]&31)===5),'Expected H264 IDR');
    await helper.request({op:'video',enabled:false});
    await helper.request({op:'release'});
    console.log('Interactive DXGI capture, JPEG, display/quality switching and H264 verified. Keyboard/mouse, lock/UAC and phone playback still require visible end-to-end acceptance.');
  } finally {await helper.stop();}
}
