import { createHash } from "crypto";
import { cache } from "react";
import { headers } from "next/headers";
import { db } from "@/lib/db";
import { isSessionRecordActive, touchSessionRecord } from "./session-store";
import { mfaPolicy } from "./config";
import type { JwtPayload } from "@/lib/auth";
import type { ModuleName } from "@/lib/auth";

export const TAB_PROOF_HEADER = "x-bloomcore-tab-proof";
export const TAB_CLIENT_HEADER = "x-bloomcore-tab-client";
export const TAB_PATH_HEADER = "x-bloomcore-tab-path";
export const TAB_REQUEST_ID_HEADER = "x-bloomcore-tab-request-id";
export const TAB_PROOF_VERSION = 1;
const PROOF_MAX_SKEW_SECONDS = 90;

/**
 * One proof is attached to one browser request, but several server helpers may
 * read the session during that request. Cache the verified result by the
 * worker-issued request id so the single-use nonce is consumed once, not once
 * per helper. A replay from a different request has a different id and fails on
 * the nonce primary key.
 */
const requestCache = new Map<
  string,
  { value: VerifiedTabProof; expiresAt: number }
>();

function cachedProof(key: string | null): VerifiedTabProof | null {
  if (!key) return null;
  const entry = requestCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    requestCache.delete(key);
    return null;
  }
  return entry.value;
}

function cacheProof(key: string | null, value: VerifiedTabProof) {
  if (!key) return;
  const now = Date.now();
  if (requestCache.size > 1000) {
    for (const [entryKey, entry] of requestCache) {
      if (entry.expiresAt <= now) requestCache.delete(entryKey);
    }
  }
  requestCache.set(key, { value, expiresAt: now + 2000 });
}

export type TabSurface = ModuleName | "platform" | "selection";

export interface TabProof {
  v: number;
  credentialId: string;
  sessionId: string;
  ts: number;
  nonce: string;
  method: string;
  path: string;
}

export interface VerifiedTabProof {
  payload: JwtPayload;
  credentialId: string;
  sessionId: string;
  module: TabSurface;
}

export function canonicalProof(proof: Omit<TabProof, "v">): string {
  return [
    `v${TAB_PROOF_VERSION}`,
    proof.credentialId,
    proof.sessionId,
    String(proof.ts),
    proof.nonce,
    proof.method.toUpperCase(),
    proof.path,
  ].join("\n");
}

function parseProof(raw: string): { proof: TabProof; signature: Uint8Array } | null {
  const [encoded, signature] = raw.split(".");
  if (!encoded || !signature) return null;
  try {
    const proof = JSON.parse(
      Buffer.from(encoded, "base64url").toString("utf8")
    ) as TabProof;
    if (proof.v !== TAB_PROOF_VERSION) return null;
    if (
      !proof.credentialId ||
      !proof.sessionId ||
      !Number.isFinite(proof.ts) ||
      !proof.nonce ||
      !proof.method ||
      typeof proof.path !== "string"
    ) {
      return null;
    }
    return { proof, signature: Buffer.from(signature, "base64url") };
  } catch {
    return null;
  }
}

async function verifySignature(
  publicKeyJwk: string,
  canonical: string,
  signature: Uint8Array
): Promise<boolean> {
  try {
    const jwk = JSON.parse(publicKeyJwk) as JsonWebKey;
    if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) return false;
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );
    const signatureBytes = signature.buffer.slice(
      signature.byteOffset,
      signature.byteOffset + signature.byteLength
    ) as ArrayBuffer;
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      signatureBytes,
      new TextEncoder().encode(canonical)
    );
  } catch {
    return false;
  }
}

/**
 * Verify the proof attached by this tab's service worker.
 *
 * Checks: credential exists, bound session is live, signature matches the
 * non-extractable tab key, timestamp is fresh, nonce is single-use, module and
 * MFA policy match. Any failure is a denial.
 */
const DEFAULT_PROOF_OPTIONS: { allowSelection?: boolean } = {};

export const verifyTabProof = cache(async function verifyTabProof(
  expected: TabSurface | "any",
  options: { allowSelection?: boolean } = DEFAULT_PROOF_OPTIONS
): Promise<VerifiedTabProof | null> {
  try {
    const requestHeaders = await headers();
    const raw = requestHeaders.get(TAB_PROOF_HEADER);
    if (!raw) return null;
    const requestId = requestHeaders.get(TAB_REQUEST_ID_HEADER);
    const cacheKey = requestId ? `${requestId}:${expected}` : null;
    const cached = cachedProof(cacheKey);
    if (cached) return cached;
    const parsed = parseProof(raw);
    if (!parsed) return null;
    const { proof, signature } = parsed;

    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - proof.ts) > PROOF_MAX_SKEW_SECONDS) return null;
    if (!proof.nonce || proof.nonce.length > 200) return null;

    const credential = await db.tabCredential.findUnique({
      where: { id: proof.credentialId },
    });
    if (!credential) return null;
    if (credential.sessionId !== proof.sessionId) return null;
    if (expected !== "any" && credential.module !== expected) {
      if (!(options.allowSelection && credential.module === "selection")) return null;
    }

    const canonical = canonicalProof(proof);
    if (!(await verifySignature(credential.publicKeyJwk, canonical, signature))) {
      return null;
    }

    if (!(await isSessionRecordActive(credential.sessionId))) return null;

    // Single-use nonce. A retry inside the SAME browser request may be seen by
    // several server helpers; the request id makes that idempotent. A replay
    // from a different request has a different id and is rejected.
    const nonceId = createHash("sha256").update(proof.nonce).digest("hex");
    try {
      await db.tabProofNonce.create({
        data: {
          id: nonceId,
          credentialId: credential.id,
          requestId,
          expiresAt: new Date((now + PROOF_MAX_SKEW_SECONDS * 2) * 1000),
        },
      });
    } catch {
      if (!requestId) return null;
      const existing = await db.tabProofNonce
        .findUnique({ where: { id: nonceId } })
        .catch(() => null);
      if (
        !existing ||
        existing.credentialId !== credential.id ||
        existing.requestId !== requestId
      ) {
        return null;
      }
    }

    const payload = JSON.parse(credential.payloadJson) as JwtPayload;
    if (
      !payload?.userId &&
      !(payload.kind === "platform" && typeof payload.adminId === "string")
    ) {
      return null;
    }
    if (payload.tokenUse === "workspace-selection" && !options.allowSelection) {
      return null;
    }
    if (mfaPolicy() === "enforce" && payload.amr !== "pwd+mfa") return null;

    await touchSessionRecord(credential.sessionId);
    await db.tabCredential
      .update({
        where: { id: credential.id },
        data: { lastUsedAt: new Date() },
      })
      .catch(() => undefined);

    const verified: VerifiedTabProof = {
      payload,
      credentialId: credential.id,
      sessionId: credential.sessionId,
      module: credential.module as TabSurface,
    };
    cacheProof(cacheKey, verified);
    return verified;
  } catch {
    return null;
  }
});

export function tabSurfaceForPayload(payload: JwtPayload): TabSurface | null {
  if (payload.kind === "platform") return "platform";
  if (payload.tokenUse === "workspace-selection") return "selection";
  if (payload.role === "customer") return "customer";
  if (payload.role === "admin") return "admin";
  if ((payload.modules ?? []).includes("momo")) return "momo";
  if ((payload.modules ?? []).includes("susu")) return "susu";
  return null;
}


