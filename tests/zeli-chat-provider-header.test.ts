import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

/**
 * Customer-facing branding guard.
 *
 * Zeli is the product name. A customer must never see the underlying AI
 * provider's name, model name, or Team Testing wording in a page, component or
 * chat response. Technical provider configuration stays in server modules and
 * in the Platform Super Admin console.
 */

const ROOT = path.resolve(__dirname, "..");
const SCANNED_ROOTS = [
  path.join(ROOT, "src", "app"),
  path.join(ROOT, "src", "components"),
];

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      // The platform console is the operator surface, not a customer surface.
      if (full.includes(`${path.sep}platform${path.sep}`)) continue;
      walk(full, files);
    } else if (/\.(tsx?|jsx?)$/.test(entry)) {
      files.push(full);
    }
  }
  return files;
}

const FORBIDDEN = [
  /deepseek/i,
  /team testing/i,
  /external provider/i,
  /provider:\s*\$\{/i,
];

describe("customer-facing Zeli branding", () => {
  const files = SCANNED_ROOTS.flatMap((dir) => walk(dir));

  it("scans a meaningful number of customer files", () => {
    expect(files.length).toBeGreaterThan(40);
  });

  it("never names the AI provider or Team Testing outside the platform console", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const relative = path.relative(ROOT, file);
      for (const pattern of FORBIDDEN) {
        if (pattern.test(source)) offenders.push(`${relative} matched ${pattern}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("does not send provider identity in the chat response headers", () => {
    const route = readFileSync(
      path.join(ROOT, "src", "app", "api", "zeli", "chat", "route.ts"),
      "utf8"
    );
    expect(route).not.toMatch(/x-zeli-provider/i);
    expect(route).not.toMatch(/x-zeli-conversation-provider/i);
    expect(route).not.toMatch(/providerPolicyHeaders/);
  });

  it("keeps the customer Zeli page free of provider and testing banners", () => {
    const page = readFileSync(path.join(ROOT, "src", "app", "zeli", "page.tsx"), "utf8");
    expect(page).not.toMatch(/deepseek/i);
    expect(page).not.toMatch(/team testing/i);
    expect(page).not.toMatch(/acceptZeliTeamDisclosure/);
  });
});
