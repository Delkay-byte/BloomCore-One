import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { prisma, cleanDatabase, createTestAdmin } from "./setup";
import { TAB_PROOF_HEADER } from "@/lib/security/tab-proof";

const store = vi.hoisted(() => ({
  headers: new Headers(),
  cookies: new Map<string, string>(),
}));

vi.mock("next/headers", () => ({
  headers: async () => store.headers,
  cookies: async () => ({
    get: (name: string) =>
      store.cookies.has(name) ? { value: store.cookies.get(name)! } : undefined,
    set: (name: string, value: string) => store.cookies.set(name, value),
    delete: (name: string) => store.cookies.delete(name),
  }),
}));

import { getAdminSession, type JwtPayload } from "@/lib/auth";
import { createSessionRecord } from "@/lib/security/session-store";

function canonical(input: {
  credentialId: string;
  sessionId: string;
  ts: number;
  nonce: string;
  method: string;
  path: string;
}): string {
  return [
    "v1",
    input.credentialId,
    input.sessionId,
    String(input.ts),
    input.nonce,
    input.method,
    input.path,
  ].join("\n");
}

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

async function signProof(
  privateKey: CryptoKey,
  input: {
    credentialId: string;
    sessionId: string;
    ts: number;
    nonce: string;
    method: string;
    path: string;
  }
): Promise<string> {
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(canonical(input))
  );
  const proof = { v: 1, ...input };
  return `${b64url(new TextEncoder().encode(JSON.stringify(proof)))}.${b64url(
    new Uint8Array(signature)
  )}`;
}

async function fixture(module = "admin") {
  const admin = await createTestAdmin();
  const sessionId = randomUUID();
  const payload: JwtPayload = {
    userId: admin.id,
    email: admin.email,
    fullName: admin.fullName,
    role: "admin",
    modules: [],
    tenantId: admin.tenantId,
    tokenVersion: admin.tokenVersion,
    amr: "pwd+mfa",
    jti: sessionId,
    tokenUse: "session",
  };
  await createSessionRecord({
    id: sessionId,
    subjectType: "user",
    subjectId: admin.id,
    tenantId: admin.tenantId,
    expiresAt: new Date(Date.now() + 60_000),
  });
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  const publicJwk = JSON.stringify(
    await crypto.subtle.exportKey("jwk", pair.publicKey)
  );
  const credential = await prisma.tabCredential.create({
    data: {
      sessionId,
      subjectType: "user",
      subjectId: admin.id,
      tenantId: admin.tenantId,
      module,
      amr: "pwd+mfa",
      payloadJson: JSON.stringify(payload),
      publicKeyJwk: publicJwk,
    },
  });
  return { admin, sessionId, payload, pair, credential };
}

describe("tab proof of possession", () => {
  beforeEach(async () => {
    await cleanDatabase();
    store.headers = new Headers();
    store.cookies.clear();
    vi.stubEnv("ALLOW_LEGACY_COOKIE_SESSIONS", "0");
    vi.stubEnv("MFA_ENFORCEMENT", "optional");
  });

  it("accepts a fresh proof bound to the tab credential and session", async () => {
    const { pair, credential, sessionId } = await fixture();
    const proof = await signProof(pair.privateKey, {
      credentialId: credential.id,
      sessionId,
      ts: Math.floor(Date.now() / 1000),
      nonce: randomUUID(),
      method: "GET",
      path: "/admin/dashboard",
    });
    store.headers.set(TAB_PROOF_HEADER, proof);
    const session = await getAdminSession();
    expect(session?.userId).toBeTruthy();
    expect(session?.jti).toBe(sessionId);
  });

  it("rejects replay of the same proof nonce", async () => {
    const { pair, credential, sessionId } = await fixture();
    const proof = await signProof(pair.privateKey, {
      credentialId: credential.id,
      sessionId,
      ts: Math.floor(Date.now() / 1000),
      nonce: randomUUID(),
      method: "GET",
      path: "/admin/dashboard",
    });
    store.headers.set(TAB_PROOF_HEADER, proof);
    expect(await getAdminSession()).not.toBeNull();
    expect(await getAdminSession()).toBeNull();
  });

  it("rejects a tampered signature", async () => {
    const { pair, credential, sessionId } = await fixture();
    const proof = await signProof(pair.privateKey, {
      credentialId: credential.id,
      sessionId,
      ts: Math.floor(Date.now() / 1000),
      nonce: randomUUID(),
      method: "GET",
      path: "/admin/dashboard",
    });
    const [encoded] = proof.split(".");
    store.headers.set(
      TAB_PROOF_HEADER,
      `${encoded}.${b64url(new Uint8Array(64))}`
    );
    expect(await getAdminSession()).toBeNull();
  });

  it("rejects a proof for a different module", async () => {
    const { pair, credential, sessionId } = await fixture("momo");
    const proof = await signProof(pair.privateKey, {
      credentialId: credential.id,
      sessionId,
      ts: Math.floor(Date.now() / 1000),
      nonce: randomUUID(),
      method: "GET",
      path: "/admin/dashboard",
    });
    store.headers.set(TAB_PROOF_HEADER, proof);
    expect(await getAdminSession()).toBeNull();
  });

  it("rejects a proof after the session is revoked", async () => {
    const { pair, credential, sessionId } = await fixture();
    await prisma.sessionRecord.update({
      where: { id: sessionId },
      data: { revokedAt: new Date(), revokedReason: "logout" },
    });
    const proof = await signProof(pair.privateKey, {
      credentialId: credential.id,
      sessionId,
      ts: Math.floor(Date.now() / 1000),
      nonce: randomUUID(),
      method: "GET",
      path: "/admin/dashboard",
    });
    store.headers.set(TAB_PROOF_HEADER, proof);
    expect(await getAdminSession()).toBeNull();
  });

  it("rejects stale and malformed proofs", async () => {
    const { pair, credential, sessionId } = await fixture();
    const stale = await signProof(pair.privateKey, {
      credentialId: credential.id,
      sessionId,
      ts: Math.floor(Date.now() / 1000) - 600,
      nonce: randomUUID(),
      method: "GET",
      path: "/admin/dashboard",
    });
    store.headers.set(TAB_PROOF_HEADER, stale);
    expect(await getAdminSession()).toBeNull();

    store.headers.set(TAB_PROOF_HEADER, "not-a-proof");
    expect(await getAdminSession()).toBeNull();

    const noCredential = await signProof(pair.privateKey, {
      credentialId: "missing",
      sessionId,
      ts: Math.floor(Date.now() / 1000),
      nonce: randomUUID(),
      method: "GET",
      path: "/admin/dashboard",
    });
    store.headers.set(TAB_PROOF_HEADER, noCredential);
    expect(await getAdminSession()).toBeNull();
  });

  it("rejects cookie-only authentication when the test bridge is off", async () => {
    const { admin } = await fixture();
    store.headers = new Headers();
    const { createToken } = await import("@/lib/auth");
    const token = await createToken({
      userId: admin.id,
      email: admin.email,
      fullName: admin.fullName,
      role: "admin",
      modules: [],
      tokenVersion: admin.tokenVersion,
      amr: "pwd+mfa",
    });
    store.cookies.set("bik-admin-session", token);
    expect(await getAdminSession()).toBeNull();
  });
});
