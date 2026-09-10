import { describe, expect, it } from "vitest";
import { Buffer } from "node:buffer";
import { encodeLiveFramePacket, readLiveFramePacket, LIVE_FRAME_PACKET_TYPE } from "./frame-packet.js";

describe("live-view v1 frame packet codec", () => {
  it("round-trips channel, sequence and payload", () => {
    const payload = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const packet = encodeLiveFramePacket({
      type: LIVE_FRAME_PACKET_TYPE.producerFrame,
      channelId: 37,
      sequence: 9,
      payload,
    });
    expect(packet[0]).toBe(1);
    expect(packet[1]).toBe(LIVE_FRAME_PACKET_TYPE.producerFrame);
    const decoded = readLiveFramePacket(packet);
    expect(decoded?.type).toBe(LIVE_FRAME_PACKET_TYPE.producerFrame);
    expect(decoded?.channelId).toBe(37);
    expect(decoded?.sequence).toBe(9);
    expect([...decoded?.payload ?? []]).toEqual([...payload]);
  });

  it("keeps the legacy byte layout byte-for-byte", () => {
    const packet = encodeLiveFramePacket({ type: LIVE_FRAME_PACKET_TYPE.watcherFrame, channelId: 0x01020304, sequence: 0x05060708, payload: new Uint8Array([9]) });
    expect([...packet.subarray(0, 10)]).toEqual([1, 4, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("rejects foreign packets: terminal frames, wrong version, truncated headers", () => {
    // 6-byte terminal input frame (type 1) shares the socket — not a live-view packet
    const terminal = Buffer.from([1, 1, 0, 0, 0, 7, 0xaa]);
    expect(readLiveFramePacket(terminal)).toBeNull();
    const wrongVersion = encodeLiveFramePacket({ type: LIVE_FRAME_PACKET_TYPE.watcherFrame, channelId: 1, sequence: 1, payload: new Uint8Array(4) });
    wrongVersion[0] = 2;
    expect(readLiveFramePacket(wrongVersion)).toBeNull();
    expect(readLiveFramePacket(new Uint8Array(9))).toBeNull();
  });

  it("decodes Buffer (Node ws) and honors byteOffset views", () => {
    const packet = encodeLiveFramePacket({ type: LIVE_FRAME_PACKET_TYPE.producerFrame, channelId: 5, sequence: 6, payload: new Uint8Array([1, 2]) });
    const buffered = readLiveFramePacket(Buffer.from(packet));
    expect(buffered?.channelId).toBe(5);
    const withPrefix = new Uint8Array(3 + packet.byteLength);
    withPrefix.set(packet, 3);
    const view = readLiveFramePacket(withPrefix.subarray(3));
    expect(view?.sequence).toBe(6);
    expect([...view?.payload ?? []]).toEqual([1, 2]);
  });
});
