import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import * as authActions from "@/lib/actions/auth.actions";
import * as sessionIssuance from "@/lib/session-issuance";

/**
 * Regression guards for the release security assessment findings.
 *
 * SEC-01: every exported async function in a "use server" module becomes a
 * callable server action. Session issuance must therefore never be exported
 * from one.
 *
 * SEC-02: the platform write guard must consult the mandatory-upgrade flag.
 *
 * SEC-03: offline contribution sync must serialize day allocation the same way
 * the online path does.
 */

const root = process.cwd();
const read = (relative: string) =>
  readFileSync(path.join(root, relative), "utf8");

describe("SEC-01 session issuance is not a server action", () => {
  it("is not exported from the authentication server-action module", () => {
    expect(Object.keys(authActions)).not.toContain("issueModuleSession");
    expect(Object.keys(authActions)).not.toContain("buildSessionPayload");
  });

  it("lives in a module without a use server directive", () => {
    const source = read("src/lib/session-issuance.ts");
    expect(source.trimStart().startsWith('"use server"')).toBe(false);
    expect(typeof sessionIssuance.issueModuleSession).toBe("function");
    expect(typeof sessionIssuance.buildSessionPayload).toBe("function");
  });

  it("keeps the authentication module itself server-only", () => {
    expect(read("src/lib/actions/auth.actions.ts").trimStart()).toMatch(
      /^"use server";/
    );
  });
});

describe("SEC-02 mandatory upgrade gates live sessions", () => {
  it("isSessionCurrent consults the tenant and portal upgrade flags", () => {
    const source = read("src/lib/auth.ts");
    const block = source.slice(source.indexOf("export async function isSessionCurrent"));
    expect(block).toContain("forcePasswordReset");
    expect(block).toContain("forcePortalPasswordReset");
  });

  it("tenant context refuses data access while an upgrade is pending", () => {
    const source = read("src/lib/tenant.ts");
    expect(source).toContain("forcePasswordReset: true");
    expect(source).toContain("forcePortalPasswordReset: true");
    expect(source).toContain("if (user.forcePasswordReset) return null;");
    expect(source).toContain("customer.forcePortalPasswordReset");
  });

  it("the platform admin guard redirects a forced-upgrade operator", () => {
    const source = read("src/lib/platform-auth.ts");
    const start = source.indexOf("export async function requirePlatformAdmin");
    const block = source.slice(start, start + 900);
    expect(block).toContain("if (session.forcePasswordReset)");
    expect(block).toContain('redirect("/platform/first-login")');
  });
});

describe("SEC-03 offline sync serializes day allocation", () => {
  it("takes the account advisory lock inside the contribution transaction", () => {
    const source = read("src/app/api/offline/sync-contribution/route.ts");
    const transactionIndex = source.indexOf("await db.$transaction(async (tx) => {");
    const lockIndex = source.indexOf("await lockAccountForUpdate(tx, accountId);");
    expect(transactionIndex).toBeGreaterThan(-1);
    expect(lockIndex).toBeGreaterThan(transactionIndex);
    expect(source).toContain('from "@/lib/db-lock"');
  });
});
