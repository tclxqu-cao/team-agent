import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

export interface PasswordRecord { hash: Buffer; salt: Buffer; version: number }
export const PASSWORD_VERSION = 1;
const KEY_LENGTH = 32;
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, SCRYPT_OPTIONS, (error, key) => error ? reject(error) : resolve(key));
  });
}

export async function hashPassword(password: string): Promise<PasswordRecord> { const salt = randomBytes(16); return { hash: await derive(password, salt), salt, version: PASSWORD_VERSION }; }
export async function verifyPassword(password: string, record: PasswordRecord): Promise<boolean> { if (record.version !== PASSWORD_VERSION || record.hash.byteLength !== KEY_LENGTH) return false; return timingSafeEqual(await derive(password, record.salt), record.hash); }
