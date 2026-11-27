import { type CompoundEncodingCost } from "../../domain/live-view/remote-compound-video.js";
export type CompoundWireFormat = "json-v1" | "binary-v1" | "binary-zstd-v1";
export interface CompoundWireTile {
    cacheId: number;
    x: number;
    y: number;
    width: number;
    height: number;
    data?: string | Uint8Array;
}
export interface BinaryCompoundTiles {
    version: 1;
    kind: "tiles";
    epoch: string;
    revision: number;
    sequence: number;
    rtpTimestamp: number;
    tiles: CompoundWireTile[];
}
export declare function compoundTileEncodingCost(format: CompoundWireFormat, epoch: string): CompoundEncodingCost;
export declare function compoundPngBytes(data: string | Uint8Array, width?: number, height?: number): Uint8Array;
/** Network byte order; raw PNG payloads and short, epoch-scoped cache IDs. */
export declare function encodeCompoundTiles(message: BinaryCompoundTiles): Uint8Array;
/** No allocation follows an unvalidated length, and no trailing bytes are accepted. */
export declare function decodeCompoundTiles(bytes: Uint8Array): BinaryCompoundTiles;
/** Accept a single dictionary-free Zstd frame with an explicit bounded content/window size. */
export declare function inflateCompoundPacket(packet: Uint8Array): Uint8Array;
//# sourceMappingURL=compound-video-wire.d.ts.map