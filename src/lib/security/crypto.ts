import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "crypto";
import { mfaEncryptionKey, rateLimitHmacSecret } from "./config";

/** Keyed HMAC used for bucket identifiers and privacy-preserving fingerprints. */
export function keyedHash(value: string): string {
  return createHmac("sha256", rateLimitHmacSecret()).update(value).digest("hex");
}

/** Unkeyed SHA-256, used only where the input is already high-entropy. */
export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

const ENCRYPTION_VERSION = "v1";

/**
 * AES-256-GCM encryption for TOTP secrets.
 * Output: v1:<iv base64>:<tag base64>:<ciphertext base64>
 */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", mfaEncryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    ENCRYPTION_VERSION,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

export function decryptSecret(payload: string): string | null {
  try {
    const [version, ivB64, tagB64, dataB64] = payload.split(":");
    if (version !== ENCRYPTION_VERSION || !ivB64 || !tagB64 || !dataB64) {
      return null;
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      mfaEncryptionKey(),
      Buffer.from(ivB64, "base64")
    );
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(dataB64, "base64")),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  } catch {
    return null;
  }
}
