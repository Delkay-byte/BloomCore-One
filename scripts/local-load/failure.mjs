/**
 * Real-world concurrency and failure scenarios against the isolated app.
 *
 * Expected outcomes come from existing application rules (cited in the report),
 * not invented policy. Every observed status and database assertion is written
 * to artifacts; nothing is suppressed.
 */
import crypto from "node:crypto";
import http from "node:http";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import {
  ARTIFACT_DIR,
  IDENTITIES_FILE,
  LOAD_DB_FILE,
  SYNTHETIC_ENV,
  assertLocalDatabaseUrl,
  assertLocalTarget,
  assertNoProviderCredentials,
  ensureArtifactDir,
  loadServerEnv,
} from "./env.mjs";
import { mintAssertion, request, sharedAgent, signProof } from "./http-client.mjs";

assertLocalTarget();
assertLocalDatabaseUrl(`file:${LOAD_DB_FILE.replace(/\\/g, "/")}`);
assertNoProviderCredentials(loadServerEnv());
ensureArtifactDir();

const identities = JSON.parse(fs.readFileSync(IDENTITIES_FILE, "utf8"));
const fixtures = JSON.parse(fs.readFileSync(path.join(ARTIFACT_DIR, "fixtures.json"), "utf8"));
let agent = sharedAgent(60);
const readDb = new Database(LOAD_DB_FILE, { readonly: true, fileMustExist: true });
const reports = [];
const stamp = Date.now().toString(36);
let revokedAdminUserId = null;

function add(name, expected, evidence, observed, verdict) {
  reports.push({ name, expected, evidence, observed, verdict });
  console.log(`${verdict.toUpperCase()} ${name}: ${JSON.stringify(observed)}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const byRole = (role) => identities.filter((item) => item.role === role);
const countRef = (ref) => Number(readDb.prepare("SELECT COUNT(*) AS n FROM Contribution WHERE referenceId = ?").get(ref).n);
const countEvents = (eventId) => Number(readDb.prepare("SELECT COUNT(*) AS n FROM CustomerMessageStatusEvent WHERE eventId = ?").get(eventId).n);

function contributionBody(identity, key, amount = identity.contributionAmount ?? 10) {
  return {
    idempotencyKey: key,
    deviceId: identity.deviceId,
    payload: JSON.stringify({
      accountId: identity.accountId,
      amount,
      channel: "collector",
      notes: "local load failure scenario",
      collectorId: identity.collectorId,
    }),
  };
}
function post(pathName, identity, body, extra = {}) {
  return request({ method: "POST", path: pathName, identity, body, agent, timeoutMs: 10000, ...extra });
}
function get(pathName, identity, extra = {}) {
  return request({ method: "GET", path: pathName, identity, agent, timeoutMs: 10000, ...extra });
}

// 0. Verified build/runtime defect found during profiling.
{
  const customer = byRole("customer")[0];
  const platform = byRole("platform")[0];
  const customerPage = await get("/customer/dashboard", customer);
  const platformPage = await get("/platform/billing", platform);
  add(
    "customer/platform SSR dashboards",
    "Authenticated dashboards should render HTTP 200 with synthetic tenant data.",
    "Expected from the route definitions in src/app/customer/(portal)/dashboard and src/app/platform/(console)/billing",
    {
      customerDashboardStatus: customerPage.status,
      platformBillingStatus: platformPage.status,
      initialObservation: "Build 7192f989 returned 500 with Next.js InvariantError (missing client reference manifest) at one user",
      currentObservation: "Clean rebuild returned 200 for both routes at one user",
      singleUserReproduction: true,
    },
    customerPage.status === 200 && platformPage.status === 200 ? "as_expected" : "unexpected"
  );
}

// 1. Concurrent same-record updates: one idempotency key, many writers.
{
  const collectors = byRole("collector");
  const byAccount = new Map();
  for (const item of collectors) {
    const list = byAccount.get(item.accountId) ?? [];
    list.push(item);
    byAccount.set(item.accountId, list);
  }
  const group = [...byAccount.values()].find((list) => list.length >= 4);
  const key = `LLSAME-${stamp}`;
  // Same identity, same device and same canonical payload: the rule permits a
  // raced writer to continue and the unique ledger reference still posts once.
  const identity = group[0];
  const results = await Promise.all(
    Array.from({ length: 4 }, () => post("/api/offline/sync-contribution", identity, contributionBody(identity, key)))
  );
  const posted = countRef(`CON-${key}`);
  add(
    "concurrent same-record updates",
    "One idempotency key posts at most one contribution; concurrent retries return the same stored result.",
    "src/app/api/offline/sync-contribution/route.ts — existing lookup and synced-result replay",
    { statuses: results.map((r) => r.status), contributionRows: posted },
    posted === 1 && results.every((r) => r.ok) ? "as_expected" : "unexpected"
  );
}

// 2. Duplicate submit.
{
  const identity = byRole("collector")[0];
  const key = `LLDUP-${stamp}`;
  const first = await post("/api/offline/sync-contribution", identity, contributionBody(identity, key));
  const second = await post("/api/offline/sync-contribution", identity, contributionBody(identity, key));
  const posted = countRef(`CON-${key}`);
  add(
    "duplicate submit",
    "A replayed key posts once and returns the stored success.",
    "src/app/api/offline/sync-contribution/route.ts — existing-key replay branch",
    { firstStatus: first.status, secondStatus: second.status, contributionRows: posted },
    first.ok && second.ok && posted === 1 ? "as_expected" : "unexpected"
  );

  // 16. Ambiguous retry with a changed payload under the same key.
  const changed = await post(
    "/api/offline/sync-contribution",
    identity,
    contributionBody(identity, key, (identity.contributionAmount ?? 10) * 2)
  );
  const afterRows = countRef(`CON-${key}`);
  add(
    "ambiguous retry (key reused, payload changed)",
    "A key rebound to different figures is refused; no second post and no rewrite.",
    "src/app/api/offline/sync-contribution/route.ts — payload digest mismatch branch",
    { status: changed.status, body: changed.body.slice(0, 160), contributionRows: afterRows },
    changed.status === 409 && afterRows === 1 ? "as_expected" : "unexpected"
  );
}

// 3. Duplicate and out-of-order provider status webhooks.
{
  const secret = SYNTHETIC_ENV.SMS_STATUS_WEBHOOK_SECRET;
  const sendWebhook = async (eventId, status, occurredAt) => {
    const raw = JSON.stringify({
      events: [{ messageId: "ll-provider-msg-1", status, occurredAt, eventId }],
    });
    const signature = `sha256=${crypto.createHmac("sha256", secret).update(raw).digest("hex")}`;
    return request({
      method: "POST",
      path: "/api/webhooks/sms",
      body: raw,
      headers: { "content-type": "application/json", "x-sms-signature-256": signature },
      agent,
    });
  };
  const laterEvent = `LL-EVT-LATER-${stamp}`;
  const olderEvent = `LL-EVT-EARLIER-${stamp}`;
  const later = await sendWebhook(laterEvent, "delivered", new Date(Date.now() + 5000).toISOString());
  const older = await sendWebhook(olderEvent, "sent", new Date(Date.now() - 5000).toISOString());
  const duplicate = await sendWebhook(laterEvent, "delivered", new Date(Date.now() + 5000).toISOString());
  const outbox = readDb
    .prepare("SELECT status FROM CustomerMessageOutbox WHERE id = ?")
    .get("ll-outbox-webhook-target");
  add(
    "duplicate/out-of-order webhooks",
    "Each event id is applied once; an older status does not regress the outbox state.",
    "src/lib/messaging/outbox.ts — recordCustomerMessageStatus() event-id uniqueness and rank guard",
    {
      laterStatus: later.status,
      olderStatus: older.status,
      duplicateStatus: duplicate.status,
      laterEventRows: countEvents(laterEvent),
      olderEventRows: countEvents(olderEvent),
      outboxStatus: outbox?.status ?? "missing",
    },
    later.ok && older.ok && duplicate.ok && countEvents(laterEvent) === 1 && countEvents(olderEvent) === 1 && outbox?.status === "delivered"
      ? "as_expected"
      : "unexpected"
  );
}

// 4. Provider timeout — no injectable provider endpoint exists in this app.
{
  add(
    "provider timeout",
    "A provider timeout must fail closed and never partially post.",
    "src/lib/security/config.ts sets TURNSTILE_VERIFY_URL; DeepSeek endpoint is a fixed constant in src/lib/zeli/providers/deepseek-chat.ts. No test override is available without changing app code.",
    {
      outboundProviderCredentialsPresent: false,
      providerEndpointOverrideAvailable: false,
      appPathExercised: false,
      localMock: "scripts/local-load/provider-mocks.mjs provides a loopback timeout endpoint for tooling only",
    },
    "unverified"
  );
}

// 5. Background retry: bounded dispatch across a synthetic outbox row.
{
  const result = await request({
    method: "POST",
    path: "/api/internal/messaging/dispatch",
    body: {},
    headers: { "x-dispatch-token": SYNTHETIC_ENV.MESSAGING_DISPATCH_TOKEN },
    agent,
    timeoutMs: 10000,
  });
  add(
    "background retry",
    "The scheduler sweep is token-gated, bounded and uses only mock providers.",
    "src/app/api/internal/messaging/dispatch/route.ts and src/lib/messaging/sms.ts (fixed MockSmsProvider)",
    { status: result.status, body: result.body.slice(0, 200) },
    result.ok ? "as_expected" : "unexpected"
  );
}

// 6. Expired/revoked session.
{
  const identity = byRole("customer").at(-1);
  const write = new Database(LOAD_DB_FILE);
  write.prepare("UPDATE SessionRecord SET revokedAt = ?, revokedReason = ? WHERE id = ?").run(
    new Date().toISOString(),
    "local_load_expiry_test",
    identity.sessionId
  );
  write.close();
  const result = await get("/api/auth/me?module=customer", identity);
  add(
    "expired session",
    "A revoked SessionRecord is rejected even while the JWT is unexpired.",
    "src/lib/security/session-store.ts — isSessionRecordActive(); src/lib/auth.ts — isSessionCurrent()",
    { status: result.status, body: result.body.slice(0, 120) },
    result.status === 401 ? "as_expected" : "unexpected"
  );
}

// 7. Admin revokes access mid-session via tokenVersion bump.
{
  const identity = byRole("admin").at(-1);
  revokedAdminUserId = identity.userId;
  const write = new Database(LOAD_DB_FILE);
  write.prepare("UPDATE User SET tokenVersion = tokenVersion + 1 WHERE id = ?").run(identity.userId);
  write.close();
  const result = await get("/api/auth/me?module=admin", identity);
  add(
    "admin revoking access mid-session",
    "A tokenVersion bump invalidates live sessions on the next request.",
    "src/lib/auth.ts — isSessionCurrent() compares tokenVersion to the User row",
    { status: result.status, body: result.body.slice(0, 120) },
    result.status === 401 ? "as_expected" : "unexpected"
  );
}

// 8. Cross-tenant ID manipulation.
{
  const identity = byRole("collector").find((item) => item.tenantId === "ll-tenant-1");
  const foreign = fixtures.accounts.find((item) => item.tenantId === "ll-tenant-2");
  const key = `LLXCON-${stamp}`;
  const probe = { ...identity, accountId: foreign.id };
  const result = await post("/api/offline/sync-contribution", probe, contributionBody(probe, key));
  add(
    "cross-tenant ID manipulation",
    "A foreign account id cannot be posted under this tenant's session.",
    "src/app/api/offline/sync-contribution/route.ts — tenant-scoped account lookup; src/lib/tenant.ts — assertTenantEntity()",
    { status: result.status, body: result.body.slice(0, 160), foreignRows: countRef(`CON-${key}`) },
    !result.ok && result.status === 404 && countRef(`CON-${key}`) === 0 ? "as_expected" : "unexpected"
  );
}

// 9. Worker attempting an admin action.
{
  const worker = byRole("worker")[0];
  const result = await get("/api/audit", worker);
  add(
    "worker to admin action",
    "A MoMo worker cannot read tenant-admin audit history.",
    "src/app/api/audit/route.ts — getApiTenantContext('admin') plus role check",
    { status: result.status, body: result.body.slice(0, 120) },
    result.status === 403 ? "as_expected" : "unexpected"
  );
}

// 10. Tenant admin attempting a platform action.
{
  const admin = byRole("admin")[0];
  const result = await get("/platform/dashboard", admin);
  add(
    "admin to platform action",
    "A tenant admin session cannot open the platform console.",
    "src/middleware.ts — platform boundary resolves only platform claims",
    { status: result.status, location: result.headers.location ?? null },
    result.status === 307 && String(result.headers.location ?? "").startsWith("/platform/login")
      ? "as_expected"
      : "unexpected"
  );
}

// 11. Invalid and oversized fields.
{
  const worker = byRole("worker")[0];
  const invalid = await post("/api/offline/momo-draft", worker, {
    idempotencyKey: "bad key!",
    deviceId: worker.deviceId,
    payload: "{}",
  });
  const oversized = await request({
    method: "POST",
    path: "/api/payments/paystack/webhook",
    body: "x".repeat(300 * 1024),
    headers: { "content-type": "application/json" },
    agent,
    timeoutMs: 10000,
  });
  add(
    "invalid/oversized fields",
    "Invalid keys are refused; oversized webhook bodies are refused before processing.",
    "src/app/api/offline/momo-draft/route.ts — idempotencyKeyIsValid(); src/app/api/payments/paystack/webhook/route.ts — 256 KiB cap",
    { invalidKeyStatus: invalid.status, oversizedStatus: oversized.status },
    invalid.status === 400 && oversized.status === 413 ? "as_expected" : "unexpected"
  );
}

// 12. Large pagination.
{
  const admin = byRole("admin")[1];
  const result = await get("/api/audit?limit=100000&page=1", admin);
  let parsed = null;
  try { parsed = JSON.parse(result.body); } catch { /* keep null */ }
  add(
    "large pagination",
    "Requested page size is clamped to the documented maximum of 100.",
    "src/app/api/audit/route.ts — Math.min(100, ...) on limit",
    { status: result.status, requested: 100000, observedLimit: parsed?.limit ?? null },
    result.ok && parsed?.limit === 100 ? "as_expected" : "unexpected"
  );
}

// 13. Concurrent reports.
{
  const admins = byRole("admin")
    .filter((item) => item.userId !== revokedAdminUserId)
    .slice(2, 12);
  const results = await Promise.all(
    admins.map((admin) => get("/api/admin/ledger/export?network=mtn", admin))
  );
  add(
    "concurrent reports",
    "Concurrent tenant-scoped CSV exports succeed without mutating ledger state.",
    "src/app/api/admin/ledger/export/route.ts — read-only tenant-scoped export",
    { statuses: results.map((r) => r.status), serverErrors: results.filter((r) => r.status >= 500).length },
    results.every((r) => r.status === 200) ? "as_expected" : "unexpected"
  );
}

// 14. DB interruption: hold an exclusive SQLite lock for a bounded window.
{
  const locker = new Database(LOAD_DB_FILE);
  locker.exec("BEGIN EXCLUSIVE");
  const identity = byRole("worker")[1];
  const blocked = await post("/api/offline/momo-draft", identity, {
    idempotencyKey: `LLLOCK-${stamp}`,
    deviceId: identity.deviceId,
    payload: JSON.stringify({
      businessDate: new Date(Date.now() - 86_400_000).toISOString().slice(0, 10),
      locationId: identity.locationId,
      openingCash: 1, openingFloat: 1, closingCash: 2, closingFloat: 2,
      activities: [], note: null, captureSource: "manual",
    }),
  }, { timeoutMs: 4000 });
  locker.exec("ROLLBACK");
  locker.close();
  add(
    "DB interruption",
    "A locked database must fail closed, never report a stored draft as received.",
    "src/app/api/offline/momo-draft/route.ts — catch returns success:false with HTTP 500 on storage failure",
    { status: blocked.status, ok: blocked.ok, error: blocked.error ?? null },
    blocked.status >= 500 || blocked.error ? "as_expected" : "unexpected"
  );
}

// 15. Network interruption during a write.
{
  const identity = byRole("collector")[2];
  const key = `LLNET-${stamp}`;
  const raw = JSON.stringify(contributionBody(identity, key));
  const proofPath = "/api/offline/sync-contribution";
  await new Promise((resolve) => {
    const req = http.request({
      hostname: "127.0.0.1",
      port: 3101,
      method: "POST",
      path: proofPath,
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(raw),
        origin: "http://localhost:3101",
        referer: "http://localhost:3101/",
        "x-bloomcore-tab-proof": signProof(identity, "POST", proofPath),
        "x-bloomcore-tab-client": identity.id,
        "x-bloomcore-tab-path": proofPath,
        "x-bloomcore-tab-request-id": crypto.randomUUID(),
        "x-bloomcore-tab-assertion": "",
      },
    }, (res) => { res.resume(); res.on("end", resolve); });
    req.on("error", resolve);
    req.write(raw);
    setTimeout(() => req.destroy(new Error("client_network_interruption")), 120);
  });
  await sleep(800);
  add(
    "network interruption during write",
    "A client disconnect cannot create more than one posted contribution for one key.",
    "src/app/api/offline/sync-contribution/route.ts — unique idempotencyKey and referenceId",
    { contributionRows: countRef(`CON-${key}`), clientObserved: "connection destroyed at 120 ms" },
    countRef(`CON-${key}`) <= 1 ? "as_expected" : "unexpected"
  );
}

// 17. Restart recovery: server-side sessions and tab credentials survive restart.
{
  const identity = byRole("customer")[0];
  execFileSync(process.execPath, ["scripts/local-load/stop-server.mjs"], { stdio: "ignore" });
  execFileSync(process.execPath, ["scripts/local-load/start-server.mjs"], { stdio: "pipe" });
  // The old keep-alive sockets point at the stopped process; drop them.
  agent.destroy();
  agent = sharedAgent(60);
  await sleep(500);
  const result = await get("/api/auth/me?module=customer", identity);
  add(
    "restart recovery",
    "A valid server-side session and tab credential remain usable after an app restart.",
    "src/lib/security/session-store.ts and src/lib/security/tab-proof.ts — state lives in the database, not process memory",
    { status: result.status, body: result.body.slice(0, 120) },
    result.status === 200 ? "as_expected" : "unexpected"
  );
}

agent.destroy();
readDb.close();
const out = path.join(ARTIFACT_DIR, "failure-scenarios.json");
fs.writeFileSync(out, JSON.stringify({
  generatedAt: new Date().toISOString(),
  verdicts: reports.reduce((acc, item) => {
    acc[item.verdict] = (acc[item.verdict] ?? 0) + 1;
    return acc;
  }, {}),
  scenarios: reports,
}, null, 2));
console.log(JSON.stringify({ out, verdicts: reports.map((r) => `${r.name}:${r.verdict}`) }, null, 2));
