import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const SALT_BYTES = 16;
const DERIVED_KEY_BYTES = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derivedKey = (await scrypt(password, salt, DERIVED_KEY_BYTES)) as Buffer;

  return `${salt.toString("base64")}:${derivedKey.toString("base64")}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [saltBase64, storedKeyBase64, ...extra] = encoded.split(":");
  if (!saltBase64 || !storedKeyBase64 || extra.length > 0) {
    return false;
  }

  const salt = Buffer.from(saltBase64, "base64");
  const storedKey = Buffer.from(storedKeyBase64, "base64");
  if (salt.length !== SALT_BYTES || storedKey.length !== DERIVED_KEY_BYTES) {
    return false;
  }

  const candidateKey = (await scrypt(password, salt, DERIVED_KEY_BYTES)) as Buffer;
  return timingSafeEqual(storedKey, candidateKey);
}
