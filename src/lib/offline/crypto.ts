/**
 * Offline local-data protection.
 *
 * The unlock passphrase is never stored. It derives an AES-256-GCM key through
 * PBKDF2-SHA-256 with a per-user/per-device random salt. A fixed marker is
 * encrypted as a verifier, so a wrong passphrase fails authentication without
 * storing a password hash.
 *
 * The derived key lives only in module memory. IndexedDB stores the salt, KDF
 * parameters, verifier ciphertext and encrypted record fields.
 */

export const UNLOCK_KDF = "PBKDF2-SHA256";
export const UNLOCK_ITERATIONS = 600_000;
export const UNLOCK_VERSION = 1;
export const MIN_PASSPHRASE_LENGTH = 12;
const VERIFIER_MARKER = "maacash-offline-unlock:v1";

export interface UnlockEnvelope {
  v: 1;
  alg: "A256GCM";
  iv: string;
  ct: string;
}

export interface OfflineUnlockRecord {
  version: 1;
  kdf: typeof UNLOCK_KDF;
  iterations: number;
  salt: string;
  verifier: UnlockEnvelope;
  /** Raw data key wrapped by the passphrase-derived key. */
  keyWrap: UnlockEnvelope;
  /** Raw data key wrapped by the recovery-code-derived key. */
  recoverySalt: string;
  recoveryKeyWrap: UnlockEnvelope;
  configuredAt: string;
}

export interface CreatedUnlockRecord {
  record: OfflineUnlockRecord;
  recoveryCode: string;
}

export interface ProtectedPayload {
  __protected: "v1";
  envelope: UnlockEnvelope;
}

export class OfflineCryptoError extends Error {
  constructor(
    public readonly code:
      | "invalid_passphrase"
      | "corrupt_data"
      | "unsupported"
      | "weak_passphrase",
    message: string
  ) {
    super(message);
    this.name = "OfflineCryptoError";
  }
}

function subtle(): SubtleCrypto {
  if (typeof crypto === "undefined" || !crypto.subtle) {
    throw new OfflineCryptoError(
      "unsupported",
      "This browser cannot protect offline data because Web Crypto is unavailable."
    );
  }
  return crypto.subtle;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export function normalizePassphrase(value: string): string {
  return value.normalize("NFKC").trim();
}

export function validatePassphrase(value: string): string | null {
  const normalized = normalizePassphrase(value);
  if (normalized.length < MIN_PASSPHRASE_LENGTH) {
    return `Use at least ${MIN_PASSPHRASE_LENGTH} characters for the offline passphrase.`;
  }
  return null;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

async function deriveKey(
  passphrase: string,
  salt: Uint8Array,
  iterations: number
): Promise<CryptoKey> {
  const material = await subtle().importKey(
    "raw",
    new TextEncoder().encode(normalizePassphrase(passphrase)),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return subtle().deriveKey(
    { name: "PBKDF2", salt: toArrayBuffer(salt), iterations, hash: "SHA-256" },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptString(
  key: CryptoKey,
  value: string
): Promise<UnlockEnvelope> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle().encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(value)
  );
  return {
    v: 1,
    alg: "A256GCM",
    iv: bytesToBase64Url(iv),
    ct: bytesToBase64Url(new Uint8Array(ct)),
  };
}

export async function decryptString(
  key: CryptoKey,
  envelope: UnlockEnvelope
): Promise<string> {
  if (
    !envelope ||
    envelope.v !== 1 ||
    envelope.alg !== "A256GCM" ||
    !envelope.iv ||
    !envelope.ct
  ) {
    throw new OfflineCryptoError("corrupt_data", "Protected offline data is unreadable.");
  }
  try {
    const plain = await subtle().decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(base64UrlToBytes(envelope.iv)) },
      key,
      toArrayBuffer(base64UrlToBytes(envelope.ct))
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw new OfflineCryptoError(
      "invalid_passphrase",
      "The offline passphrase is incorrect."
    );
  }
}

function generateRecoveryCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const chars = Array.from(bytes, (byte) => alphabet[byte % alphabet.length]);
  return `MAA-${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars
    .slice(8, 12)
    .join("")}-${chars.slice(12, 16).join("")}`;
}

async function wrapDataKey(
  wrappingKey: CryptoKey,
  rawDataKey: Uint8Array
): Promise<UnlockEnvelope> {
  return encryptString(wrappingKey, bytesToBase64Url(rawDataKey));
}

async function unwrapDataKey(
  wrappingKey: CryptoKey,
  envelope: UnlockEnvelope
): Promise<CryptoKey> {
  const encoded = await decryptString(wrappingKey, envelope);
  const raw = base64UrlToBytes(encoded);
  if (raw.byteLength !== 32) {
    throw new OfflineCryptoError("corrupt_data", "Protected offline key is invalid.");
  }
  return subtle().importKey("raw", toArrayBuffer(raw), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function createUnlockRecord(
  passphrase: string
): Promise<CreatedUnlockRecord> {
  const weak = validatePassphrase(passphrase);
  if (weak) throw new OfflineCryptoError("weak_passphrase", weak);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const recoverySalt = crypto.getRandomValues(new Uint8Array(16));
  const recoveryCode = generateRecoveryCode();
  const passKey = await deriveKey(passphrase, salt, UNLOCK_ITERATIONS);
  const recoveryKey = await deriveKey(
    recoveryCode,
    recoverySalt,
    UNLOCK_ITERATIONS
  );
  const rawDataKey = crypto.getRandomValues(new Uint8Array(32));
  const dataKey = await subtle().importKey(
    "raw",
    toArrayBuffer(rawDataKey),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"]
  );
  const verifier = await encryptString(dataKey, VERIFIER_MARKER);
  const keyWrap = await wrapDataKey(passKey, rawDataKey);
  const recoveryKeyWrap = await wrapDataKey(recoveryKey, rawDataKey);
  return {
    record: {
      version: 1,
      kdf: UNLOCK_KDF,
      iterations: UNLOCK_ITERATIONS,
      salt: bytesToBase64Url(salt),
      verifier,
      keyWrap,
      recoverySalt: bytesToBase64Url(recoverySalt),
      recoveryKeyWrap,
      configuredAt: new Date().toISOString(),
    },
    recoveryCode,
  };
}

async function unlockDataKey(
  wrappingKey: CryptoKey,
  record: OfflineUnlockRecord
): Promise<CryptoKey> {
  const dataKey = await unwrapDataKey(wrappingKey, record.keyWrap);
  let marker: string;
  try {
    marker = await decryptString(dataKey, record.verifier);
  } catch {
    throw new OfflineCryptoError(
      "invalid_passphrase",
      "The offline passphrase is incorrect."
    );
  }
  if (marker !== VERIFIER_MARKER) {
    throw new OfflineCryptoError(
      "invalid_passphrase",
      "The offline passphrase is incorrect."
    );
  }
  return dataKey;
}

export async function unlockWithRecord(
  passphrase: string,
  record: OfflineUnlockRecord
): Promise<CryptoKey> {
  if (
    !record ||
    record.version !== 1 ||
    record.kdf !== UNLOCK_KDF ||
    !Number.isFinite(record.iterations) ||
    record.iterations < 100_000 ||
    !record.salt ||
    !record.verifier ||
    !record.keyWrap
  ) {
    throw new OfflineCryptoError(
      "unsupported",
      "This device's offline unlock record is not supported."
    );
  }
  const wrappingKey = await deriveKey(
    passphrase,
    base64UrlToBytes(record.salt),
    record.iterations
  );
  return unlockDataKey(wrappingKey, record);
}

export async function unlockWithRecoveryCode(
  recoveryCode: string,
  record: OfflineUnlockRecord
): Promise<CryptoKey> {
  if (
    !record ||
    record.version !== 1 ||
    !Number.isFinite(record.iterations) ||
    record.iterations < 100_000 ||
    !record.recoverySalt ||
    !record.recoveryKeyWrap ||
    !record.verifier
  ) {
    throw new OfflineCryptoError(
      "unsupported",
      "This device has no valid recovery key. Use the offline passphrase."
    );
  }
  const wrappingKey = await deriveKey(
    recoveryCode.trim().toUpperCase(),
    base64UrlToBytes(record.recoverySalt),
    record.iterations
  );
  try {
    return await unlockDataKey(wrappingKey, {
      ...record,
      keyWrap: record.recoveryKeyWrap,
    });
  } catch {
    throw new OfflineCryptoError(
      "invalid_passphrase",
      "The offline recovery code is incorrect."
    );
  }
}

export function isProtectedPayload(value: unknown): value is ProtectedPayload {
  return Boolean(
    value &&
      typeof value === "object" &&
      (value as ProtectedPayload).__protected === "v1" &&
      (value as ProtectedPayload).envelope
  );
}

export async function protectValue(
  key: CryptoKey,
  value: unknown
): Promise<ProtectedPayload> {
  const envelope = await encryptString(key, JSON.stringify(value));
  return { __protected: "v1", envelope };
}

export async function unprotectValue<T>(
  key: CryptoKey,
  value: ProtectedPayload
): Promise<T> {
  const json = await decryptString(key, value.envelope);
  try {
    return JSON.parse(json) as T;
  } catch {
    throw new OfflineCryptoError("corrupt_data", "Protected offline data is unreadable.");
  }
}
