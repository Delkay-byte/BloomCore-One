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

  it("uses a signed per-tab proof, not a bearer header or cookie", () => {
    const worker = source("public/tab-session-sw.js");
    expect(worker).toContain("x-bloomcore-tab-proof");
    expect(worker).toContain("crypto.subtle.sign");
    expect(worker).toContain("event.resultingClientId");
    expect(worker).toContain("indexedDB");
    expect(worker).toContain("privateKey");
    expect(worker).not.toMatch(/localStorage\s*\./);
    expect(worker).not.toContain("x-bloomcore-tab-session");
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
    expect(client).toContain('postMessage({ type: "bootstrap", token })');
    expect(client).toContain("crypto.subtle");
  });

  it("sign-out never deletes pending offline records", () => {
    const button = source("src/components/ConfirmSignOutButton.tsx");
    expect(button).not.toContain("discardCurrentOfflineData");
    expect(button).toContain("endOfflineSession");
  });
});
