import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyIdentityChange } from "@/lib/offline/session-identity";

function source(relative: string): string {
  return readFileSync(path.join(process.cwd(), relative), "utf8");
}

describe("tab session identity", () => {
  it("classifies first, same and changed identities", () => {
    expect(classifyIdentityChange(null, "user-a")).toBe("initial");
    expect(classifyIdentityChange("user-a", "user-a")).toBe("same");
    expect(classifyIdentityChange("user-a", "user-b")).toBe("changed");
  });

  it("injects the per-tab handle through the service worker, not a cookie", () => {
    const worker = source("public/tab-session-sw.js");
    expect(worker).toContain("x-bloomcore-tab-session");
    expect(worker).toContain("event.resultingClientId");
    expect(worker).toContain("indexedDB");
    expect(worker).not.toMatch(/document\.cookie|localStorage\s*\./);
  });

  it("writes a legacy cookie only behind the explicit test bridge", () => {
    const auth = source("src/lib/auth.ts");
    const platform = source("src/lib/platform-auth.ts");
    expect(auth).toMatch(
      /if \(allowLegacyCookieSessions\(\)\) \{[\s\S]{0,400}cookieStore\.set\(\s*SESSION_COOKIES/
    );
    expect(platform).toMatch(
      /if \(allowLegacyCookieSessions\(\)\) \{[\s\S]{0,400}\(await cookies\(\)\)\.set\(\s*PLATFORM_COOKIE/
    );
  });

  it("keeps the credential out of URLs and localStorage", () => {
    const client = source("src/lib/security/tab-session-client.ts");
    expect(client).not.toMatch(/localStorage\s*\./);
    expect(client).not.toMatch(/[?&](token|session)=/);
    expect(client).toContain("postMessage({ type: \"register\", token })");
  });

  it("sign-out never deletes pending offline records", () => {
    const button = source("src/components/ConfirmSignOutButton.tsx");
    expect(button).not.toContain("discardCurrentOfflineData");
    expect(button).toContain("endOfflineSession");
  });
});
