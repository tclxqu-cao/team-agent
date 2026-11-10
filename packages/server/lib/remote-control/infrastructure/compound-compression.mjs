import zstdCodec from 'zstd-codec';

let initialized;
export function createCompoundCompressor() {
  initialized ??= new Promise(resolve => zstdCodec.ZstdCodec.run(zstd => {
    const codec = new zstd.Simple();
    resolve(bytes => codec.compress(bytes, 1));
  }));
  return initialized;
}

export function compressCompoundPacket(bytes, compress) {
  if (!compress || bytes.length < 256) return bytes;
  const compressed = compress(bytes);
  if (!compressed || compressed.length + 8 >= bytes.length) return bytes;
  const packet = new Uint8Array(compressed.length + 8);
  packet.set([65, 82, 67, 90]); new DataView(packet.buffer).setUint32(4, bytes.length);
  packet.set(compressed, 8);
  return packet;
}
