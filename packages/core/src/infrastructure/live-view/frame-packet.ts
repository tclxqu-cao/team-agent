/**
 * Codec for the live-view v1 binary packet: a 10-byte header followed by the
 * JPEG payload. Encoded/decoded with raw magic numbers in three places
 * (producer client, ws relay, console shell) until now — the layout lives
 * here so the wire format can only change in one place.
 *
 *   byte 0      version (1)
 *   byte 1      packet type
 *   bytes 2-5   channelId (u32 BE)
 *   bytes 6-9   sequence  (u32 BE)
 *   bytes 10..  payload
 *
 * Type 4 (watcher frame) flows server → watching console; type 5 (producer
 * frame) flows producer → server. Terminal byte packets use a different
 * 6-byte header and are out of scope here.
 */
export const LIVE_FRAME_PACKET_VERSION = 1;
export const LIVE_FRAME_PACKET_TYPE = {
  /** server → watching peer, live-view frame relay */
  watcherFrame: 4,
  /** producer → server, live-view frame publish */
  producerFrame: 5,
} as const;

const HEADER_BYTES = 10;

export interface LiveFramePacketInput {
  type: (typeof LIVE_FRAME_PACKET_TYPE)[keyof typeof LIVE_FRAME_PACKET_TYPE];
  channelId: number;
  sequence: number;
  payload: Uint8Array;
}

/** Encode a v1 live-view packet. `payload` must not exceed 640 KiB (domain cap). */
export function encodeLiveFramePacket({ type, channelId, sequence, payload }: LiveFramePacketInput): Uint8Array {
  const packet = new Uint8Array(HEADER_BYTES + payload.byteLength);
  packet[0] = LIVE_FRAME_PACKET_VERSION;
  packet[1] = type;
  const view = new DataView(packet.buffer);
  view.setUint32(2, channelId, false);
  view.setUint32(6, sequence >>> 0, false);
  packet.set(payload, HEADER_BYTES);
  return packet;
}

export interface LiveFramePacket {
  type: number;
  channelId: number;
  sequence: number;
  /** Zero-copy view into the input buffer. */
  payload: Uint8Array;
}

/** Decode a v1 live-view packet; null when the bytes are not one (other packet kinds share the socket). */
export function readLiveFramePacket(data: ArrayBufferView | Uint8Array): LiveFramePacket | null {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (bytes.byteLength < HEADER_BYTES) return null;
  if (bytes[0] !== LIVE_FRAME_PACKET_VERSION) return null;
  if (bytes[1] !== LIVE_FRAME_PACKET_TYPE.watcherFrame && bytes[1] !== LIVE_FRAME_PACKET_TYPE.producerFrame) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    type: bytes[1],
    channelId: view.getUint32(2, false),
    sequence: view.getUint32(6, false),
    payload: bytes.subarray(HEADER_BYTES),
  };
}
