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
export declare const LIVE_FRAME_PACKET_VERSION = 1;
export declare const LIVE_FRAME_PACKET_TYPE: {
    /** server → watching peer, live-view frame relay */
    readonly watcherFrame: 4;
    /** producer → server, live-view frame publish */
    readonly producerFrame: 5;
};
export interface LiveFramePacketInput {
    type: (typeof LIVE_FRAME_PACKET_TYPE)[keyof typeof LIVE_FRAME_PACKET_TYPE];
    channelId: number;
    sequence: number;
    payload: Uint8Array;
}
/** Encode a v1 live-view packet. `payload` must not exceed 640 KiB (domain cap). */
export declare function encodeLiveFramePacket({ type, channelId, sequence, payload }: LiveFramePacketInput): Uint8Array;
export interface LiveFramePacket {
    type: number;
    channelId: number;
    sequence: number;
    /** Zero-copy view into the input buffer. */
    payload: Uint8Array;
}
/** Decode a v1 live-view packet; null when the bytes are not one (other packet kinds share the socket). */
export declare function readLiveFramePacket(data: ArrayBufferView | Uint8Array): LiveFramePacket | null;
//# sourceMappingURL=frame-packet.d.ts.map