/**
 * Supply-chain regression: every third-party GitHub Action must be pinned to a
 * verified full commit SHA, and container images must not use a mutable tag.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  path.join(process.cwd(), ".github/workflows/ci.yml"),
  "utf8"
);

describe("CI supply-chain pins", () => {
  it("pins every uses: reference to a 40-character commit SHA", () => {
    const uses = workflow
      .split(/\r?\n/)
      .filter((line) => /^\s*-?\s*uses:\s/.test(line));
    expect(uses.length).toBeGreaterThan(0);
    for (const line of uses) {
      expect(line, line).toMatch(/uses:\s+[^\s@]+@[a-f0-9]{40}\s*(?:#.*)?$/);
    }
  });

  it("does not use a mutable latest image tag", () => {
    expect(workflow).not.toContain(":latest");
  });

  it("uses least-privilege default token permissions", () => {
    expect(workflow).toMatch(/permissions:\s*\r?\n\s*contents:\s*read/);
  });

  it("keeps CodeQL SARIF as an artifact until code scanning is verified", () => {
    expect(workflow).toContain("upload: never");
  });

  it("declares a dependency review workflow", () => {
    expect(workflow).toContain("dependency-review:");
    expect(workflow).toContain("npm audit --omit=dev --audit-level=high");
  });
});
