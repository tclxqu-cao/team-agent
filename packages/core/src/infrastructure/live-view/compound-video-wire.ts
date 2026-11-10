import { REMOTE_COMPOUND_VIDEO as limits, type CompoundEncodingCost } from "../../domain/live-view/remote-compound-video.js";
import { decompress } from "fzstd";

export type CompoundWireFormat = "json-v1" | "binary-v1" | "binary-zstd-v1";
export interface CompoundWireTile {
  cacheId: number; x: number; y: number; width: number; height: number; data?: string | Uint8Array;
}
export interface BinaryCompoundTiles {
  version: 1; kind: "tiles"; epoch: string; revision: number; sequence: number; rtpTimestamp: number;
  tiles: CompoundWireTile[];
}

const HEADER = 30;
const TILE = 10;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function compoundTileEncodingCost(format: CompoundWireFormat, epoch: string): CompoundEncodingCost {
  return format !== "json-v1"
    ? { headerBytes: HEADER + encoder.encode(epoch).length, tileBytes: TILE, payloadNumerator: 1, payloadDenominator: 1 }
    : { headerBytes: 256, tileBytes: 192, payloadNumerator: 4, payloadDenominator: 3 };
}

export function compoundPngBytes(data: string | Uint8Array, width?: number, height?: number): Uint8Array {
  let bytes: Uint8Array;
  if (typeof data === "string") {
    if (data.length > Math.ceil(limits.maxTileBytes / 3) * 4 || data.length % 4 !== 0
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new Error("Invalid compound image");
    bytes = Uint8Array.from(atob(data), char => char.charCodeAt(0));
  } else bytes = data;
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!(bytes instanceof Uint8Array) || bytes.length < 24 || bytes.length > limits.maxTileBytes
    || signature.some((byte, i) => bytes[i] !== byte)
    || String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") throw new Error("Invalid PNG header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const w = view.getUint32(16), h = view.getUint32(20);
  if (w < 1 || h < 1 || w > limits.tileSize || h > limits.tileSize
    || width !== undefined && w !== width || height !== undefined && h !== height) throw new Error("Invalid PNG dimensions");
  return bytes;
}

function validTile(tile: CompoundWireTile): boolean {
  return [tile.cacheId, tile.x, tile.y, tile.width, tile.height].every(Number.isSafeInteger)
    && tile.cacheId >= 1 && tile.cacheId <= limits.maxCacheEntries
    && tile.x >= 0 && tile.y >= 0 && tile.width > 0 && tile.height > 0
    && tile.width <= limits.tileSize && tile.height <= limits.tileSize
    && tile.x % limits.tileSize === 0 && tile.y % limits.tileSize === 0
    && tile.x + tile.width <= limits.maxDimension && tile.y + tile.height <= limits.maxDimension;
}

function validBatch(message: BinaryCompoundTiles): boolean {
  return message.version === 1 && message.kind === "tiles"
    && typeof message.epoch === "string" && message.epoch.length > 0 && encoder.encode(message.epoch).length <= 120
    && Number.isSafeInteger(message.revision) && message.revision >= 0
    && Number.isSafeInteger(message.sequence) && message.sequence > 0
    && Number.isInteger(message.rtpTimestamp) && message.rtpTimestamp >= 0 && message.rtpTimestamp <= 0xffff_ffff
    && Array.isArray(message.tiles) && message.tiles.length > 0 && message.tiles.length <= limits.maxTiles;
}

/** Network byte order; raw PNG payloads and short, epoch-scoped cache IDs. */
export function encodeCompoundTiles(message: BinaryCompoundTiles): Uint8Array {
  if (!validBatch(message)) throw new Error("Invalid compound batch");
  const epoch = encoder.encode(message.epoch);
  const payloads = message.tiles.map(tile => {
    if (!validTile(tile)) throw new Error("Invalid compound tile");
    return tile.data === undefined ? null : compoundPngBytes(tile.data, tile.width, tile.height);
  });
  const size = HEADER + epoch.length + payloads.reduce((sum, data) => sum + TILE + (data?.length ?? 0), 0);
  if (size > limits.maxMessageBytes) throw new Error("Compound message too large");
  const bytes = new Uint8Array(size), view = new DataView(bytes.buffer);
  bytes.set([65, 82, 67, 86, 1, 1]);
  view.setUint16(6, epoch.length); view.setFloat64(8, message.revision); view.setFloat64(16, message.sequence);
  view.setUint32(24, message.rtpTimestamp); view.setUint16(28, message.tiles.length);
  bytes.set(epoch, HEADER);
  let offset = HEADER + epoch.length;
  message.tiles.forEach((tile, i) => {
    const data = payloads[i];
    view.setUint16(offset, tile.cacheId); view.setUint16(offset + 2, tile.x); view.setUint16(offset + 4, tile.y);
    view.setUint8(offset + 6, tile.width); view.setUint8(offset + 7, tile.height); view.setUint16(offset + 8, data?.length ?? 0);
    offset += TILE;
    if (data) { bytes.set(data, offset); offset += data.length; }
  });
  return bytes;
}

/** No allocation follows an unvalidated length, and no trailing bytes are accepted. */
export function decodeCompoundTiles(bytes: Uint8Array): BinaryCompoundTiles {
  if (bytes[0] === 65 && bytes[1] === 82 && bytes[2] === 67 && bytes[3] === 90) return decodeCompoundTiles(inflateCompoundPacket(bytes));
  if (bytes.length < HEADER || bytes.length > limits.maxMessageBytes
    || [65, 82, 67, 86, 1, 1].some((byte, i) => bytes[i] !== byte)) throw new Error("Invalid compound binary header");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const epochLength = view.getUint16(6), count = view.getUint16(28);
  if (!epochLength || epochLength > 120 || !count || count > limits.maxTiles
    || HEADER + epochLength + count * TILE > bytes.length) throw new Error("Invalid compound binary lengths");
  const message: BinaryCompoundTiles = {
    version: 1, kind: "tiles", epoch: decoder.decode(bytes.subarray(HEADER, HEADER + epochLength)),
    revision: view.getFloat64(8), sequence: view.getFloat64(16), rtpTimestamp: view.getUint32(24), tiles: [],
  };
  let offset = HEADER + epochLength;
  const positions = new Set<string>(), puts = new Set<number>();
  for (let i = 0; i < count; i++) {
    if (offset + TILE > bytes.length) throw new Error("Truncated compound tile");
    const tile: CompoundWireTile = { cacheId: view.getUint16(offset), x: view.getUint16(offset + 2), y: view.getUint16(offset + 4),
      width: view.getUint8(offset + 6), height: view.getUint8(offset + 7) };
    const length = view.getUint16(offset + 8);
    offset += TILE;
    const position = `${tile.x},${tile.y}`;
    if (!validTile(tile) || positions.has(position) || offset + length > bytes.length) throw new Error("Invalid compound tile bounds");
    positions.add(position);
    if (length) {
      if (puts.has(tile.cacheId)) throw new Error("Duplicate compound cache insertion");
      puts.add(tile.cacheId);
      tile.data = compoundPngBytes(bytes.subarray(offset, offset + length), tile.width, tile.height);
      offset += length;
    }
    message.tiles.push(tile);
  }
  if (offset !== bytes.length || !validBatch(message)) throw new Error("Invalid compound binary batch");
  return message;
}

/** Accept a single dictionary-free Zstd frame with an explicit bounded content/window size. */
export function inflateCompoundPacket(packet: Uint8Array): Uint8Array {
  if (packet.length < 14 || packet.length > limits.maxMessageBytes) throw new Error("Invalid compressed compound length");
  const expected = new DataView(packet.buffer, packet.byteOffset).getUint32(4);
  if (expected < HEADER || expected > limits.maxMessageBytes) throw new Error("Invalid compound output length");
  const data = packet.subarray(8);
  if ([40, 181, 47, 253].some((byte, i) => data[i] !== byte)) throw new Error("Invalid Zstd magic");
  const descriptor = data[4], single = (descriptor & 32) !== 0, flag = descriptor >>> 6;
  if (descriptor & 27) throw new Error("Unsupported Zstd dictionary/reserved bits");
  let offset = 5;
  if (!single) {
    const window = data[offset++], base = 2 ** (10 + (window >>> 3));
    if (base + base / 8 * (window & 7) > 65_536) throw new Error("Compound Zstd window too large");
  }
  const sizeBytes = flag === 0 ? single ? 1 : 0 : flag === 1 ? 2 : flag === 2 ? 4 : 8;
  if (!sizeBytes || offset + sizeBytes > data.length) throw new Error("Zstd content size required");
  let size = 0;
  for (let i = 0; i < sizeBytes; i++) size += data[offset + i] * 2 ** (8 * i);
  if (sizeBytes === 2) size += 256;
  if (size !== expected) throw new Error("Zstd content size differs");
  // Walk block lengths to reject concatenated frames/trailing bytes before the decoder allocates.
  offset += sizeBytes;
  let last = false;
  while (!last) {
    if (offset + 3 > data.length) throw new Error("Truncated Zstd block");
    const header = data[offset] | data[offset + 1] << 8 | data[offset + 2] << 16;
    offset += 3; last = (header & 1) !== 0;
    const type = header >>> 1 & 3, length = header >>> 3;
    if (type === 3 || length > 131_072) throw new Error("Invalid Zstd block");
    offset += type === 1 ? 1 : length;
    if (offset > data.length) throw new Error("Truncated Zstd payload");
  }
  if (descriptor & 4) offset += 4;
  if (offset !== data.length) throw new Error("Trailing compound Zstd data");
  const result = decompress(data, new Uint8Array(expected));
  if (result.length !== expected || result[3] !== 86) throw new Error("Invalid decompressed compound packet");
  return result;
}
