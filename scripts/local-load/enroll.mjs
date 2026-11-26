/**
 * Create 1,000 valid synthetic VU identities through the real
 * POST /api/auth/tab/enroll route.
 *
 * Passwords are not exercised here: each VU starts from a pre-authenticated
 * synthetic session minted with the local-only JWT secret. The tab credential,
 * server-side SessionRecord, proof verification and tenant resolution are all
 * real application code. This assumption is recorded in the load-test plan.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaPg } from "@prisma/adapter-pg";
import { SignJWT } from "jose";
import {
  ARTIFACT_DIR,
  IDENTITIES_FILE,
  LOAD_DB_PROVIDER,
  LOAD_DB_URL,
  SYNTHETIC_ENV,
  VU_COUNT,
  assertLocalDatabaseUrl,
  assertLocalTarget,
} from "./env.mjs";
import { request, sharedAgent } from "./http-client.mjs";

assertLocalTarget();
assertLocalDatabaseUrl(LOAD_DB_URL);

const fixtures = JSON.parse(fs.readFileSync(path.join(ARTIFACT_DIR, "fixtures.json"), "utf8"));
const prisma =
  LOAD_DB_PROVIDER === "postgresql"
    ? new PrismaClient({ adapter: new PrismaPg({ connectionString: LOAD_DB_URL }) })
    : new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: LOAD_DB_URL.split("?")[0] }) });
const agent = sharedAgent(40);
const now = Math.floor(Date.now() / 1000);

function roleFor(index) {
  const slot = index % 100;
  if (slot < 15) return "admin";
  if (slot < 37) return "worker";
  if (slot < 57) return "collector";
  if (slot < 95) return "customer";
  return "platform";
}

async function mintToken(payload, audience, hours) {
  return new SignJWT({ ...payload, iat: now, lastActivityAt: now })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt(now)
    .setExpirationTime(`${hours}h`)
    .setIssuer("bloomcore-one")
    .setAudience(audience)
    .sign(new TextEncoder().encode(SYNTHETIC_ENV.JWT_SECRET));
}

const prepared = [];
try {
  for (let vu = 1; vu <= VU_COUNT; vu += 1) {
    const role = roleFor(vu - 1);
    const jti = crypto.randomUUID();
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const privateJwk = privateKey.export({ format: "jwk" });
    const publicJwkObject = publicKey.export({ format: "jwk" });
    const publicKeyJwk = JSON.stringify({
      kty: "EC",
      crv: "P-256",
      x: publicJwkObject.x,
      y: publicJwkObject.y,
    });
    let identity;
    let token;

    if (role === "platform") {
      const admin = fixtures.users.platform[0];
      identity = {
        module: "platform",
        userId: admin.id,
        email: "platform@local-load.test",
        fullName: "Local Load Platform Operator",
        kind: "platform",
      };
      token = await mintToken(
        {
          adminId: admin.id,
          role: "admin",
          kind: "platform",
          tokenUse: "platform",
          tokenVersion: 0,
          amr: "pwd",
          jti,
        },
        "bloomcore-one:platform",
        4
      );
    } else {
      const pool = fixtures.users[role];
      const user = pool[(vu - 1) % pool.length];
      const modules = role === "admin" ? ["momo", "susu"] : role === "worker" ? ["momo"] : role === "collector" ? ["susu"] : ["customer"];
      identity = { module: user.module, userId: user.id, tenantId: user.tenantId, email: `${role}-${vu}@local-load.test`, fullName: `Local Load ${role} ${vu}` };
      const extra = {};
      if (role === "worker" || role === "admin") {
        identity.locationId = user.locationId;
        extra.locationId = user.locationId;
      }
      if (role === "collector") {
        const account = fixtures.accounts[(vu - 7) % fixtures.accounts.length];
        identity.userId = account.collectorUserId;
        identity.tenantId = account.tenantId;
        extra.collectorId = account.collectorId;
      }
      token = await mintToken(
        {
          userId: identity.userId,
          email: identity.email,
          fullName: identity.fullName,
          role,
          modules,
          module: user.module,
          tenantId: identity.tenantId,
          tokenVersion: 0,
          amr: "pwd",
          jti,
          ...extra,
        },
        "bloomcore-one:session",
        8
      );
    }

    const subjectType = role === "platform" ? "platform" : role === "customer" ? "customer" : "user";
    await prisma.sessionRecord.create({
      data: {
        id: jti,
        subjectType,
        subjectId: identity.userId,
        tenantId: identity.tenantId ?? null,
        expiresAt: new Date(Date.now() + (role === "platform" ? 4 : 8) * 3_600_000),
      },
    });

    let deviceId = null;
    let accountId = null;
    let collectorId = null;
    if (role === "worker" || role === "collector") {
      deviceId = `ll-device-vu-${vu}`;
      await prisma.deviceEnrollment.create({
        data: {
          id: `ll-device-row-vu-${vu}`,
          tenantId: identity.tenantId,
          userId: identity.userId,
          deviceId,
          deviceName: `Local Load VU ${vu} device`,
          module: role === "worker" ? "momo" : "susu",
          status: "active",
          authorizedAt: new Date(),
        },
      });
    }
    if (role === "collector") {
      const account = fixtures.accounts[(vu - 7) % fixtures.accounts.length];
      accountId = account.id;
      collectorId = account.collectorId;
      identity.contributionAmount = account.dailyContribution;
    }

    prepared.push({
      vu,
      id: `ll-vu-${String(vu).padStart(4, "0")}`,
      role,
      module: identity.module,
      userId: identity.userId,
      tenantId: identity.tenantId ?? null,
      email: identity.email,
      jwt: token,
      jti,
      privateJwk,
      publicKeyJwk,
      deviceId,
      accountId,
      collectorId,
      locationId: identity.locationId ?? null,
      contributionAmount: identity.contributionAmount ?? null,
    });
  }
} finally {
  await prisma.$disconnect();
}

const enrolled = new Array(VU_COUNT);
let cursor = 0;
const CONCURRENCY = 25;

async function enrollOne() {
  while (cursor < prepared.length) {
    const item = prepared[cursor++];
    const result = await request({
      method: "POST",
      path: "/api/auth/tab/enroll",
      body: { publicKeyJwk: item.publicKeyJwk },
      headers: { authorization: `Bearer ${item.jwt}` },
      timeoutMs: 20000,
      agent,
    });
    if (!result.ok) {
      throw new Error(
        `VU ${item.vu} enrollment failed: status=${result.status} body=${result.body.slice(0, 160)}`
      );
    }
    let data;
    try {
      data = JSON.parse(result.body);
    } catch {
      throw new Error(`VU ${item.vu} enrollment returned non-JSON`);
    }
    enrolled[item.vu - 1] = {
      ...item,
      credentialId: data.credentialId,
      sessionId: data.sessionId,
      assertion: data.assertion,
      assertionExpiresIn: data.assertionExpiresIn,
    };
  }
}

try {
  await Promise.all(Array.from({ length: CONCURRENCY }, () => enrollOne()));
} finally {
  agent.destroy();
}

if (enrolled.some((item) => !item)) {
  throw new Error("Enrollment produced an incomplete identity set.");
}

const tmp = `${IDENTITIES_FILE}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(enrolled, null, 2));
fs.renameSync(tmp, IDENTITIES_FILE);

const byRole = enrolled.reduce((acc, item) => {
  acc[item.role] = (acc[item.role] ?? 0) + 1;
  return acc;
}, {});
console.log(JSON.stringify({ enrolled: enrolled.length, byRole, identitiesFile: IDENTITIES_FILE }, null, 2));
