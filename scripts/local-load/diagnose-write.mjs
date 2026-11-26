/** Temporary diagnostic for one authenticated write. */
import fs from "node:fs";
import { IDENTITIES_FILE, assertLocalTarget } from "./env.mjs";
import { request, sharedAgent } from "./http-client.mjs";
assertLocalTarget();
const identities = JSON.parse(fs.readFileSync(IDENTITIES_FILE, "utf8"));
const role = process.argv[2] ?? "worker";
const identity = identities.find((item) => item.role === role);
const agent = sharedAgent(10);
console.log("identity", { vu: identity.vu, role, userId: identity.userId, tenantId: identity.tenantId, deviceId: identity.deviceId, accountId: identity.accountId, locationId: identity.locationId });
const stamp = Date.now().toString(36);
if (role === "worker") {
  const body = {
    idempotencyKey: `LLDIAG-${stamp}`,
    deviceId: identity.deviceId,
    payload: JSON.stringify({
      businessDate: new Date(Date.now() - 86400000).toISOString().slice(0, 10),
      locationId: identity.locationId,
      openingCash: 1, openingFloat: 1, closingCash: 2, closingFloat: 2,
      activities: [], note: null, captureSource: "manual",
    }),
  };
  const r = await request({ method: "POST", path: "/api/offline/momo-draft", identity, body, agent });
  console.log("momoDraft", r.status, r.body.slice(0, 500));
} else {
  const body = {
    idempotencyKey: `LLDIAG-${stamp}`,
    deviceId: identity.deviceId,
    payload: JSON.stringify({ accountId: identity.accountId, amount: identity.contributionAmount ?? 10, channel: "collector", notes: "diag", collectorId: identity.collectorId }),
  };
  const r = await request({ method: "POST", path: "/api/offline/sync-contribution", identity, body, agent });
  console.log("contribution", r.status, r.body.slice(0, 500));
}
agent.destroy();
