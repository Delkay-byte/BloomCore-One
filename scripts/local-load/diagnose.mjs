/** Temporary diagnostic for one authenticated request. */
import fs from "node:fs";
import { IDENTITIES_FILE, assertLocalTarget } from "./env.mjs";
import { request, sharedAgent, mintAssertion } from "./http-client.mjs";

assertLocalTarget();
const identities = JSON.parse(fs.readFileSync(IDENTITIES_FILE, "utf8"));
const identity = identities[Number(process.argv[2] ?? 1) - 1];
const pathName = process.argv[3] ?? "/admin/dashboard";
const agent = sharedAgent(10);
console.log("identity", { vu: identity.vu, role: identity.role, module: identity.module, tenantId: identity.tenantId, userId: identity.userId, credentialId: identity.credentialId, assertion: (await mintAssertion(identity)).slice(0, 24) + "..." });
for (const p of [pathName, "/api/auth/me?module=admin", "/api/auth/session"]) {
  const result = await request({ method: "GET", path: p, identity, agent, timeoutMs: 10000 });
  console.log(p, { status: result.status, location: result.headers.location, body: result.body.slice(0, 300) });
}
agent.destroy();
