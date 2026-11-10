import { describe, expect, it } from "vitest";
import { compoundTileEncodingCost, decodeCompoundTiles, encodeCompoundTiles } from "./compound-video-wire.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAkklEQVR4nO3QQREAAAiAMPuX1hh7yBJwzD43OkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAO0ARtDDsqXe37wAAAAASUVORK5CYII=";
const tile = { cacheId: 1, x: 0, y: 0, width: 64, height: 64, data: png };
const batch = { version: 1 as const, kind: "tiles" as const, epoch: "e", revision: 1, sequence: 1, rtpTimestamp: 0xffff_ffff,
  tiles: [tile, { ...tile, x: 64, data: undefined }] };

describe("bounded compound binary wire format", () => {
  it("roundtrips raw PNG puts and compact cache reuse with exact byte accounting", () => {
    const bytes = encodeCompoundTiles(batch);
    const decoded = decodeCompoundTiles(bytes);
    expect(decoded).toMatchObject({ ...batch, tiles: [{ ...tile, data: expect.any(Uint8Array) }, { cacheId: 1, x: 64, y: 0, width: 64, height: 64 }] });
    expect(Buffer.from(decoded.tiles[0].data as Uint8Array).toString("base64")).toBe(png);
    expect(bytes.length).toBe(30 + 1 + 20 + Buffer.from(png, "base64").length);
    const json = JSON.stringify({ ...batch, tiles: batch.tiles.map(tile => ({ ...tile, key: "a".repeat(64) })) });
    expect(bytes.length).toBeLessThan(Buffer.byteLength(json) * 0.6);
    expect(compoundTileEncodingCost("binary-v1", "e").headerBytes).toBe(31);
    // Buffer/typed-array slices must honor byte offsets.
    expect(decodeCompoundTiles(Buffer.concat([Buffer.alloc(7), bytes]).subarray(7)).sequence).toBe(1);
  });

  it("rejects every truncated prefix, trailing data and invalid header fields", () => {
    const bytes = encodeCompoundTiles(batch);
    for (let end = 0; end < bytes.length; end++) expect(() => decodeCompoundTiles(bytes.subarray(0, end))).toThrow();
    expect(() => decodeCompoundTiles(new Uint8Array([...bytes, 0]))).toThrow();
    for (const offset of [0, 4, 5, 6, 28]) {
      const damaged = bytes.slice(); damaged[offset] = 255;
      expect(() => decodeCompoundTiles(damaged)).toThrow();
    }
    const invalidUtf8 = bytes.slice(); invalidUtf8[30] = 255;
    expect(() => decodeCompoundTiles(invalidUtf8)).toThrow();
    const unsafe = bytes.slice(); new DataView(unsafe.buffer).setFloat64(16, Number.MAX_SAFE_INTEGER + 1);
    expect(() => decodeCompoundTiles(unsafe)).toThrow();
  });

  it("rejects invalid cache IDs, duplicate positions, oversized payloads and wrong PNG dimensions", () => {
    expect(() => encodeCompoundTiles({ ...batch, tiles: [{ ...tile, cacheId: 0 }] })).toThrow();
    expect(() => encodeCompoundTiles({ ...batch, tiles: [{ ...tile, width: 32 }] })).toThrow();
    expect(() => encodeCompoundTiles({ ...batch, epoch: "中".repeat(41) })).toThrow();
    expect(() => decodeCompoundTiles(encodeCompoundTiles({ ...batch, tiles: [tile, tile] }))).toThrow();
    expect(() => decodeCompoundTiles(encodeCompoundTiles({ ...batch, tiles: [tile, { ...tile, x: 64 }] }))).toThrow();
    const bytes = encodeCompoundTiles(batch); new DataView(bytes.buffer).setUint16(39, 65535);
    expect(() => decodeCompoundTiles(bytes)).toThrow();
  });
});
