import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Release-configuration consistency. The previous release shipped a blueprint
 * that said MFA was optional while the runbook said production was enforced.
 * These assertions keep the repository honest; the live Render value is
 * verified separately through the Render API.
 */
function read(name: string): string {
  return readFileSync(join(process.cwd(), name), "utf8");
}

describe("production blueprint", () => {
  it("requires MFA for the production service", () => {
    const yaml = read("render.yaml");
    expect(yaml).toMatch(/name: maacash\r?\n/);
    expect(yaml).toMatch(/MFA_ENFORCEMENT[\s\S]{0,40}value: "enforce"/);
    expect(yaml).not.toMatch(/MFA_ENFORCEMENT[\s\S]{0,40}value: "optional"/);
  });

  it("keeps the production branch and health check explicit", () => {
    const yaml = read("render.yaml");
    expect(yaml).toMatch(/branch: main/);
    expect(yaml).toMatch(/healthCheckPath: \/api\/health/);
    expect(yaml).toMatch(/autoDeploy: true/);
  });

  it("keeps staging manual, isolated and on a TEST payment key contract", () => {
    const yaml = read("render.staging.yaml");
    expect(yaml).toMatch(/name: bloomcore-one-staging/);
    expect(yaml).toMatch(/autoDeploy: false/);
    expect(yaml).toMatch(/MFA_ENFORCEMENT[\s\S]{0,40}value: "enforce"/);
    expect(yaml).toMatch(/ZELI_SYNTHETIC_TESTING_ALLOWED\r?\n\s+value: "false"/);
  });

  it("does not hardcode a payment secret or an approved external-AI constant", () => {
    for (const file of ["render.yaml", "render.staging.yaml"]) {
      const yaml = read(file);
      expect(yaml).not.toMatch(/sk_live_/);
      expect(yaml).not.toMatch(/sk_test_/);
      expect(yaml).not.toMatch(/DEEPSEEK_API_KEY\r?\n\s+value:/);
    }
    const control = read("src/lib/zeli/provider-control.ts");
    expect(control).toMatch(/PRODUCTION_PROVIDER_APPROVED = false/);
  });
});
