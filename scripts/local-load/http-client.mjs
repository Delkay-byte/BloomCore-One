/**
 * Protocol-level client for MaaCash's real tab-scoped session transport.
 *
 * This reproduces what public/tab-session-sw.js does: sign a short-lived
 * ECDSA P-256 proof over `method`, path, timestamp, nonce and request id, and
 * attach a 120-second route assertion. Every data request still goes through
 * the application's real verifyTabProof(), SessionRecord and tenant resolver.
 */
import http from "node:http";
import crypto from "node:crypto";
import { SignJWT } from "jose";
import { BASE_URL, assertLocalTarget, SYNTHETIC_ENV } from "./env.mjs";

assertLocalTarget();

const target = new URL(BASE_URL);
const assertionCache = new Map();

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

export function signProof(identity, method, requestPath) {
  const now = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomUUID();
  const proof = {
    v: 1,
    credentialId: identity.credentialId,
    sessionId: identity.sessionId,
    ts: now,
    nonce,
    method: method.toUpperCase(),
    path: requestPath,
  };
  const canonical = [
    "v1",
    proof.credentialId,
    proof.sessionId,
    String(proof.ts),
    proof.nonce,
    proof.method,
    proof.path,
  ].join("\n");
  const privateKey = crypto.createPrivateKey({ key: identity.privateJwk, format: "jwk" });
  const signature = crypto.sign("sha256", Buffer.from(canonical), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${base64url(JSON.stringify(proof))}.${base64url(signature)}`;
}

export async function mintAssertion(identity) {
  const cached = assertionCache.get(identity.vu);
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.expiresAt > now + 25) return cached.value;
  const value = await new SignJWT({
    sid: identity.sessionId,
    module: identity.module,
    role: identity.role === "platform" ? "admin" : identity.role,
    kind: identity.role === "platform" ? "platform" : undefined,
    adminId: identity.role === "platform" ? identity.userId : undefined,
    amr: "pwd",
    iat: now,
    exp: now + 120,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime("120s")
    .setIssuer("bloomcore-one")
    .setAudience("bloomcore-one:tab-assertion")
    .sign(new TextEncoder().encode(SYNTHETIC_ENV.JWT_SECRET));
  assertionCache.set(identity.vu, { value, expiresAt: now + 120 });
  return value;
}

export function clearAssertionCache() {
  assertionCache.clear();
}

/**
 * One HTTP request. Never throws for network/HTTP failures: the caller gets a
 * structured result so failed iterations are counted, not hidden.
 */
export async function request({ method = "GET", path: requestPath = "/", identity = null, body, headers = {}, timeoutMs = 10000, agent, capBytes = 2 * 1024 * 1024 }) {
  const started = performance.now();
  const assertionHeader = identity ? await mintAssertion(identity) : null;
  return new Promise((resolve) => {
    const url = new URL(requestPath, target);
    const finalPath = `${url.pathname}${url.search}`;
    const requestHeaders = {
      accept: "application/json,text/html,text/csv;q=0.9,*/*;q=0.8",
      "user-agent": "maacash-local-load/1.0",
      // The app's same-origin guard resolves request.url origin as
      // http://localhost:3101 under `next start`; use that loopback alias while
      // still connecting to 127.0.0.1. Verified in diagnose-write.mjs.
      origin: "http://localhost:3101",
      referer: "http://localhost:3101/",
      ...headers,
    };
    if (identity) {
      requestHeaders["x-bloomcore-tab-proof"] = signProof(identity, method, finalPath);
      requestHeaders["x-bloomcore-tab-assertion"] = assertionHeader;
      requestHeaders["x-bloomcore-tab-client"] = identity.id;
      requestHeaders["x-bloomcore-tab-path"] = finalPath;
      requestHeaders["x-bloomcore-tab-request-id"] = crypto.randomUUID();
      requestHeaders["x-bloomcore-tab-version"] = "2";
    }
    if (body !== undefined && typeof body !== "string") {
      requestHeaders["content-type"] = "application/json";
    }
    const payload = typeof body === "string" ? body : body === undefined ? undefined : JSON.stringify(body);
    if (payload !== undefined) {
      requestHeaders["content-length"] = Buffer.byteLength(payload);
    }

    const req = http.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        method,
        path: finalPath,
        headers: requestHeaders,
        agent,
      },
      (res) => {
        const chunks = [];
        let bytes = 0;
        let truncated = false;
        res.on("data", (chunk) => {
          bytes += chunk.length;
          if (bytes <= capBytes) chunks.push(chunk);
          else truncated = true;
        });
        res.on("end", () => {
          const elapsed = performance.now() - started;
          res.resume();
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
            elapsedMs: Number(elapsed.toFixed(2)),
            ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
            truncated,
            bytes,
          });
        });
      }
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error("timeout")));
    req.on("error", (error) => {
      const elapsed = performance.now() - started;
      resolve({
        status: 0,
        headers: {},
        body: "",
        elapsedMs: Number(elapsed.toFixed(2)),
        ok: false,
        error: error.code || error.name || error.message,
      });
    });
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

export function sharedAgent(maxSockets) {
  return new http.Agent({ keepAlive: true, maxSockets, maxFreeSockets: Math.max(50, maxSockets) });
}
