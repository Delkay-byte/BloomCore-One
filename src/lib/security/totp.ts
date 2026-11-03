import { createHmac, randomBytes, createHash, timingSafeEqual } from "crypto";

/**
 * RFC 6238 TOTP (SHA-1, 6 digits, 30-second step) implemented on node:crypto.
 * No third-party dependency is required, and the secret never leaves the server.
 */

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;
const DIGITS = 6;

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(input: string): Buffer {
  const normalized = input.toUpperCase().replace(/=+$/g, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of normalized) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) throw new Error("Invalid base32 secret");
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

function hotp(secret: Buffer, counter: number): string {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", secret).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

export function totpCode(secret: string, now: number = Date.now()): string {
  return hotp(base32Decode(secret), Math.floor(now / 1000 / STEP_SECONDS));
}

export function totpStep(now: number = Date.now()): number {
  return Math.floor(now / 1000 / STEP_SECONDS);
}

/**
 * Return the matched time step, or null. Constant-time per candidate.
 * The window allows ±N steps for normal clock drift.
 */
export function verifyTotpStep(
  secret: string,
  code: string,
  now: number = Date.now(),
  window = 1
): number | null {
  const normalized = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(normalized)) return null;
  const counter = totpStep(now);
  let key: Buffer;
  try {
    key = base32Decode(secret);
  } catch {
    return null;
  }
  for (let offset = -window; offset <= window; offset += 1) {
    const step = counter + offset;
    const expected = hotp(key, step);
    const left = Buffer.from(expected);
    const right = Buffer.from(normalized);
    if (left.length === right.length && timingSafeEqual(left, right)) {
      return step;
    }
  }
  return null;
}

/** Verify a code with a ±1 step window, in constant time. */
export function verifyTotp(
  secret: string,
  code: string,
  now: number = Date.now(),
  window = 1
): boolean {
  const normalized = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(normalized)) return false;
  const counter = Math.floor(now / 1000 / STEP_SECONDS);
  const key = base32Decode(secret);
  for (let offset = -window; offset <= window; offset++) {
    const expected = hotp(key, counter + offset);
    const left = Buffer.from(expected);
    const right = Buffer.from(normalized);
    if (left.length === right.length && timingSafeEqual(left, right)) {
      return true;
    }
  }
  return false;
}

export function otpauthUrl(params: {
  secret: string;
  accountName: string;
  issuer: string;
}): string {
  const label = encodeURIComponent(`${params.issuer}:${params.accountName}`);
  const query = new URLSearchParams({
    secret: params.secret,
    issuer: params.issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${query.toString()}`;
}

const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateRecoveryCodes(count = 10): string[] {
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    let code = "";
    const bytes = randomBytes(10);
    for (let j = 0; j < 10; j++) {
      code += RECOVERY_ALPHABET[bytes[j] % RECOVERY_ALPHABET.length];
    }
    codes.push(`${code.slice(0, 5)}-${code.slice(5)}`);
  }
  return codes;
}

export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function hashRecoveryCode(code: string): string {
  return createHash("sha256")
    .update(`recovery:${normalizeRecoveryCode(code)}`)
    .digest("hex");
}

/** Consume a recovery code. Returns the remaining hash list, or null. */
export function consumeRecoveryCode(
  storedJson: string | null,
  code: string
): { ok: boolean; remaining: string | null } {
  if (!storedJson) return { ok: false, remaining: storedJson };
  let hashes: string[] = [];
  try {
    const parsed = JSON.parse(storedJson);
    if (!Array.isArray(parsed)) return { ok: false, remaining: storedJson };
    hashes = parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return { ok: false, remaining: storedJson };
  }

  const target = hashRecoveryCode(code);
  const index = hashes.indexOf(target);
  if (index === -1) return { ok: false, remaining: storedJson };

  hashes.splice(index, 1);
  return {
    ok: true,
    remaining: hashes.length > 0 ? JSON.stringify(hashes) : null,
  };
}
