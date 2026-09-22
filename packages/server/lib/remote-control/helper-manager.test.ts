import { it, expect, vi } from 'vitest';
import { connect } from 'node:net';
import { decodeVideoFrames, encodeVideoFrame, MAX_VIDEO_FRAME_BYTES, RemoteHelper } from './helper-manager.mjs';

function connectHelperSockets(controlPath:string, videoPath:string) {
  return { control: connect(controlPath), video: connect(videoPath) };
}

it('round-trips fragmented binary video frames without Base64 expansion',()=>{
 const first=encodeVideoFrame({timestamp:1.25,key:true,nals:[Buffer.from([0x67,1]),Buffer.from([0x65,2,3])]});
 const second=encodeVideoFrame({timestamp:2,key:false,nals:[Buffer.from([0x41,4])]});
 const partial=decodeVideoFrames(Buffer.concat([first,second.subarray(0,7)]));
 expect(partial.frames).toEqual([{timestamp:1.25,key:true,nals:[Buffer.from([0x67,1]),Buffer.from([0x65,2,3])]}]);
 expect(partial.remaining).toEqual(second.subarray(0,7));
 expect(decodeVideoFrames(Buffer.concat([partial.remaining,second.subarray(7)])).frames[0]).toEqual({timestamp:2,key:false,nals:[Buffer.from([0x41,4])]});
});

it('rejects malformed or oversized binary video frames',()=>{
 const oversized=Buffer.alloc(4);oversized.writeUInt32BE(MAX_VIDEO_FRAME_BYTES+1);
 expect(()=>decodeVideoFrames(oversized)).toThrow('length');
 const trailing=encodeVideoFrame({timestamp:1,nals:[Buffer.from([1])]});trailing.writeUInt32BE(trailing.readUInt32BE(0)+1,0);
 expect(()=>decodeVideoFrames(Buffer.concat([trailing,Buffer.from([0])]))).toThrow('trailing');
});

it('cancels a pending native launch immediately and permits retry', async () => {
  const launch = vi.fn(async()=>{});
  const helper = new RemoteHelper({launch});
  helper.available = async()=>true;
  const start = helper.start();
  const cancelled = expect(start).rejects.toThrow('取消');
  await vi.waitFor(()=>expect(launch).toHaveBeenCalledOnce());
  await helper.stop(); await cancelled;
  expect(helper.starting).toBeNull(); expect(helper.directory).toBeNull();
});

it('receives an original-quality binary keyframe larger than 2 MB without disconnecting',async()=>{
 let clients:any;
 const helper=new RemoteHelper({launch:async(controlPath:string,videoPath:string)=>{clients=connectHelperSockets(controlPath,videoPath);}});helper.available=async()=>true;
 const receive=vi.fn();helper.onVideo(receive);
 try{
  await helper.start();
  const nal=Buffer.alloc(2_500_000,7);
  clients.video.write(encodeVideoFrame({timestamp:1,key:true,nals:[nal]}));
  await vi.waitFor(()=>expect(receive).toHaveBeenCalledOnce());
  expect(receive.mock.calls[0][0]).toEqual({timestamp:1,key:true,nals:[nal]});expect(helper.videoSocket.destroyed).toBe(false);
 }finally{clients?.control.destroy();clients?.video.destroy();await helper.stop();}
});

it('restarts the owned helper when the binary video socket disconnects',async()=>{
 const launches:any[]=[];
 const helper=new RemoteHelper({stopTimeoutMs:10,launch:async(controlPath:string,videoPath:string)=>{
  const clients=connectHelperSockets(controlPath,videoPath);launches.push(clients);
 }});helper.available=async()=>true;
 const receive=vi.fn();helper.onVideo(receive);
 try{
  await helper.start();launches[0].video.destroy();
  await vi.waitFor(()=>expect(helper.videoSocket).toBeNull());
  expect(receive).toHaveBeenCalledWith({error:'远程视频通道已断开'});
  await helper.start();expect(launches).toHaveLength(2);expect(helper.videoSocket?.destroyed).toBe(false);
 }finally{for(const clients of launches){clients.control.destroy();clients.video.destroy();}await helper.stop();}
});

it('rejects an oversized unfinished helper message',async()=>{
 const {MAX_HELPER_MESSAGE_CHARS}=await import('./helper-manager.mjs');let clients:any;
 const helper=new RemoteHelper({launch:async(controlPath:string,videoPath:string)=>{clients=connectHelperSockets(controlPath,videoPath);clients.control.on('error',()=>{});}});helper.available=async()=>true;
 try{
  await helper.start();clients.control.write('A'.repeat(MAX_HELPER_MESSAGE_CHARS+1));
  await vi.waitFor(()=>expect(helper.socket).toBeNull(), { timeout: 5_000 });
 }finally{clients?.control.destroy();clients?.video.destroy();await helper.stop();}
});

it('asks only its connected helper to quit and waits for the owned socket to close',async()=>{
 let clients:any;let command:any;
 const helper=new RemoteHelper({stopTimeoutMs:100,launch:async(controlPath:string,videoPath:string)=>{
  clients=connectHelperSockets(controlPath,videoPath);clients.control.setEncoding('utf8');clients.control.once('data',(chunk:string)=>{command=JSON.parse(chunk.trim());clients.control.end();clients.video.end();});
 }});helper.available=async()=>true;
 await helper.start();await helper.stop();
 expect(command).toMatchObject({op:'quit'});expect(helper.socket).toBeNull();expect(helper.directory).toBeNull();
});

it('routes native encoder error events without consuming pending command replies',async()=>{
 let clients:any;
 const helper=new RemoteHelper({launch:async(controlPath:string,videoPath:string)=>{
  clients=connectHelperSockets(controlPath,videoPath);clients.control.setEncoding('utf8');
 }});helper.available=async()=>true;
 const receive=vi.fn();helper.onVideo(receive);
 try{
  await helper.start();
  clients.control.write(JSON.stringify({event:'video',error:'High profile unavailable'})+'\n');
  await vi.waitFor(()=>expect(receive).toHaveBeenCalledWith({event:'video',error:'High profile unavailable'}));
  expect(helper.pending.size).toBe(0);
 }finally{clients?.control.destroy();clients?.video.destroy();await helper.stop();}
});

it('routes native audio frames independently from command replies',async()=>{
 let clients:any;
 const helper=new RemoteHelper({launch:async(controlPath:string,videoPath:string)=>{clients=connectHelperSockets(controlPath,videoPath);}});helper.available=async()=>true;
 const receive=vi.fn();helper.onAudio(receive);
 try{
  await helper.start();clients.control.write(JSON.stringify({event:'audio',sequence:1,sampleRate:48000,channels:2,data:'AAE='})+'\n');
  await vi.waitFor(()=>expect(receive).toHaveBeenCalledWith({event:'audio',sequence:1,sampleRate:48000,channels:2,data:'AAE='}));
  expect(helper.pending.size).toBe(0);
 }finally{clients?.control.destroy();clients?.video.destroy();await helper.stop();}
});
