import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { classifyIdentityChange } from "@/lib/offline/session-identity";

function source(relative: string): string {
  return readFileSync(path.join(process.cwd(), relative), "utf8");
}

describe("cross-tab session identity", () => {
  it("accepts the first verified identity of a tab", () => {
    expect(classifyIdentityChange(null, "user-a")).toBe("initial");
  });

  it("keeps the tab when the same user is revalidated", () => {
    expect(classifyIdentityChange("user-a", "user-a")).toBe("same");
  });

  it("invalidates the tab when another user takes the shared cookie", () => {
    expect(classifyIdentityChange("user-a", "user-b")).toBe("changed");
  });

  it("uses BroadcastChannel rather than sessionStorage events for cross-tab signals", () => {
    const guard = source("src/components/TabSessionGuard.tsx");
    expect(guard).toContain("BroadcastChannel");
    expect(guard).toContain("session-changed");
    expect(guard).not.toMatch(/addEventListener\(\s*["']storage["']/);
  });

  it("broadcasts no user, tenant or token data", () => {
    const guard = source("src/components/TabSessionGuard.tsx");
    expect(guard).toMatch(/postMessage\(\{\s*type:\s*["']session-changed["']\s*\}\)/);
    expect(guard).not.toMatch(/postMessage\([^)]*(userId|tenantId|token|password)/i);
  });

  it("revalidates with the server and closes offline access on a signal", () => {
    const guard = source("src/components/TabSessionGuard.tsx");
    expect(guard).toContain("/api/auth/me");
    expect(guard).toContain("closeCurrentOfflineSession()");
    expect(guard).toContain("classifyIdentityChange");
  });

  it("sign-out never deletes pending records", () => {
    const button = source("src/components/ConfirmSignOutButton.tsx");
    expect(button).not.toContain("discardCurrentOfflineData");
    expect(button).toContain("endOfflineSession");
  });
});
