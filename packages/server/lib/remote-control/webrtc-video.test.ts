import {it, expect, vi} from 'vitest';
import {RTCPeerConnection, RTCRtpCodecParameters} from 'werift';
import {packetizeH264, RemoteWebrtcVideo} from './webrtc-video.mjs';
it('fragments H264 NALs without dropping bytes, marks only the frame end and wraps sequence',()=>{
 const nal=Buffer.alloc(3500,42);nal[0]=0x65;
 const packets=packetizeH264([Buffer.from([0x67,1,2]),nal],123,{sequence:65535,ssrc:7});
 expect(packets.map(p=>p.header.sequenceNumber)).toEqual([65535,0,1,2]);
 expect(packets.map(p=>p.header.marker)).toEqual([false,false,false,true]);
 expect(Buffer.concat([Buffer.from([0x65]),...packets.slice(1).map(p=>p.payload.subarray(2))])).toEqual(nal);
});
it('negotiates actual WebRTC, sends encrypted video RTP and stops the encoder on close',async()=>{
 let receiveVideo:any;
 const helper={onVideo:(fn:any)=>{receiveVideo=fn;return()=>{receiveVideo=null;}},request:vi.fn(async()=>({ok:true}))};
 const viewer=new RTCPeerConnection({iceServers:[],codecs:{video:[new RTCRtpCodecParameters({mimeType:'video/H264',clockRate:90000,payloadType:96,parameters:'packetization-mode=1;profile-level-id=42e01f;level-asymmetry-allowed=1'})]}});
 let offer:any; const frames:any[]=[];
 const video=new RemoteWebrtcVideo({helper,signal:(data:any)=>{if(data.kind==='offer')offer=data.sdp;}});
 viewer.onTrack.subscribe(track=>track.onReceiveRtp.subscribe(p=>frames.push(p)));
 try{
  await video.handle({kind:'start'});
  await viewer.setRemoteDescription(offer);
  await viewer.setLocalDescription(await viewer.createAnswer());
  await video.handle({kind:'answer',sdp:viewer.localDescription});
  await vi.waitFor(()=>expect(video.connected).toBe(true),{timeout:15000});
  receiveVideo({timestamp:1,nals:[Buffer.from([0x65,1,2,3]).toString('base64')]});
  await vi.waitFor(()=>expect(frames.length).toBeGreaterThan(0));
  expect(frames[0].payload).toEqual(Buffer.from([0x65,1,2,3]));
  const peer=video.peer;video.pause();
  receiveVideo({timestamp:2,nals:[Buffer.from([0x65,9]).toString('base64')]});
  await video.resume();expect(video.peer).toBe(peer);expect(video.connected).toBe(true);
  receiveVideo({timestamp:3,nals:[Buffer.from([0x65,4,5,6]).toString('base64')]});
  await vi.waitFor(()=>expect(frames.length).toBe(2));
  expect(frames[1].payload).toEqual(Buffer.from([0x65,4,5,6]));

  await video.stop();expect(helper.request).toHaveBeenCalledWith({op:'video',enabled:false});expect(receiveVideo).toBeNull();
 }finally{await video.stop();await viewer.close();}
},30000);

it('keeps a static desktop connected and only fails when the helper probe fails',async()=>{
 vi.useFakeTimers();
 const helper={request:vi.fn(async()=>({ok:true}))};const signal=vi.fn();
 const video=new RemoteWebrtcVideo({helper,signal});const peer={close:vi.fn(async()=>{})};video.peer=peer;video.connected=true;
 try{
  video.watchFrames(peer);await vi.advanceTimersByTimeAsync(16000);
  expect(video.peer).toBe(peer);expect(video.connected).toBe(true);expect(peer.close).not.toHaveBeenCalled();
  expect(helper.request).toHaveBeenCalledTimes(3);
  helper.request.mockRejectedValueOnce(new Error('helper disconnected'));
  await vi.advanceTimersByTimeAsync(5000);
  expect(signal).toHaveBeenCalledWith({kind:'state',state:'failed'});expect(peer.close).toHaveBeenCalledOnce();
 }finally{await video.stop();vi.useRealTimers();}
});

it('closes video transport on a Windows encoder failure so JPEG viewing can resume', async () => {
  let receive:any;
  const helper={onVideo:(callback:any)=>{receive=callback;return()=>{};},request:vi.fn(async()=>({ok:true}))};
  const signal=vi.fn();const video=new RemoteWebrtcVideo({helper,signal});
  try {
    await video.handle({kind:'start'});
    receive({error:'Media Foundation encoder unavailable'});
    await vi.waitFor(()=>expect(video.peer).toBeNull());
    expect(video.connected).toBe(false);
    expect(signal).toHaveBeenCalledWith({kind:'state',state:'failed'});
    expect(helper.request).toHaveBeenCalledWith({op:'video',enabled:false});
  } finally {await video.stop();}
});
