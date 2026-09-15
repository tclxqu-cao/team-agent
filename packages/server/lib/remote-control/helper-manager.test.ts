import { it, expect, vi } from 'vitest';
import { RemoteHelper } from './helper-manager.mjs';
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

it('receives an original-quality keyframe larger than 2 MB without disconnecting',async()=>{
 const {connect}=await import('node:net');let client:any;
 const helper=new RemoteHelper({launch:async(path:string)=>{client=connect(path);}});helper.available=async()=>true;
 const receive=vi.fn();helper.onVideo(receive);
 try{
  await helper.start();
  const nal='A'.repeat(2_500_000);
  client.write(JSON.stringify({event:'video',nals:[nal],timestamp:1})+'\n');
  await vi.waitFor(()=>expect(receive).toHaveBeenCalledOnce());
  expect(receive.mock.calls[0][0].nals[0]).toHaveLength(nal.length);expect(helper.socket.destroyed).toBe(false);
 }finally{client?.destroy();await helper.stop();}
});

it('rejects an oversized unfinished helper message',async()=>{
 const {connect}=await import('node:net');const {MAX_HELPER_MESSAGE_CHARS}=await import('./helper-manager.mjs');let client:any;
 const helper=new RemoteHelper({launch:async(path:string)=>{client=connect(path);client.on('error',()=>{});}});helper.available=async()=>true;
 try{
  await helper.start();client.write('A'.repeat(MAX_HELPER_MESSAGE_CHARS+1));
  await vi.waitFor(()=>expect(helper.socket).toBeNull());
 }finally{client?.destroy();await helper.stop();}
});
