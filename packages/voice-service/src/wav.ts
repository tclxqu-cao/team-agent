export function encodeFloat32Wav(samples: Float32Array, sampleRate: number): Buffer {
  if (!Number.isSafeInteger(sampleRate) || sampleRate <= 0) {
    throw new Error("sampleRate must be a positive integer");
  }
  const dataBytes = samples.length * Float32Array.BYTES_PER_ELEMENT;
  const output = Buffer.allocUnsafe(44 + dataBytes);
  output.write("RIFF", 0, "ascii");
  output.writeUInt32LE(36 + dataBytes, 4);
  output.write("WAVE", 8, "ascii");
  output.write("fmt ", 12, "ascii");
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(3, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * 4, 28);
  output.writeUInt16LE(4, 32);
  output.writeUInt16LE(32, 34);
  output.write("data", 36, "ascii");
  output.writeUInt32LE(dataBytes, 40);
  for (let index = 0; index < samples.length; index += 1) {
    output.writeFloatLE(samples[index], 44 + index * 4);
  }
  return output;
}
