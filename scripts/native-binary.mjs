import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";

const MACHO_64_LE = 0xfeedfacf;
const MACHO_CPU_ARM64 = 0x0100000c;
const PE_SIGNATURE = 0x00004550;
const PE_MACHINE_X64 = 0x8664;

export async function sha256File(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(hash.digest("hex")));
  });
}

export async function assertNativeTarget(path, target) {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const header = buffer.subarray(0, bytesRead);
    if (target === "darwin-arm64") {
      if (header.length < 8 || header.readUInt32LE(0) !== MACHO_64_LE || header.readUInt32LE(4) !== MACHO_CPU_ARM64) {
        throw new Error(`expected Mach-O arm64 binary: ${path}`);
      }
      return;
    }
    if (target === "windows-amd64") {
      if (readPeMachine(header) !== PE_MACHINE_X64) throw new Error(`expected PE32+ x86-64 binary: ${path}`);
      return;
    }
    throw new Error(`unsupported native target: ${target}`);
  } finally {
    await handle.close();
  }
}

export function readPeMachine(buffer) {
  if (buffer.length < 0x40 || buffer.readUInt16LE(0) !== 0x5a4d) throw new Error("missing MZ header");
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset + 6 > buffer.length || buffer.readUInt32LE(peOffset) !== PE_SIGNATURE) throw new Error("missing PE header");
  return buffer.readUInt16LE(peOffset + 4);
}
