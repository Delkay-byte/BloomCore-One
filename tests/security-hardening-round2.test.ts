import { createHmac } from "node:crypto";
import { execFileSync } from "child_process";
import path from "path";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getClientIp } from "@/lib/security/client-ip";
import { isSameOriginRequest } from "@/lib/security/same-origin";
import { isStaticAssetPath } from "@/lib/security/static-assets";
import { GET as healthGet } from "@/app/api/health/route";
import { GET as readyGet } from "@/app/api/health/ready/route";
import { db } from "@/lib/db";
import { middleware } from "@/middleware";
import {
  expectedRemittanceAmount,
  validateRemittanceAmount,
} from "@/lib/finance/remittance";
import { readFileSync } from "fs";

const read = (relative: string) => readFileSync(path.join(process.cwd(), relative), "utf8");

/**
 * Regression suite for the round-two hardening findings:
 * SEC-05 trusted proxy headers, SEC-09 middleware static bypass,
 * SEC-10 health disclosure, SEC-12 environment-file hygiene.
 */

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("SEC-05 client identity attribution", () => {
  // Synthetic test-only secret. No production value is used or printed.
  const EDGE_SECRET = "test-only-edge-secret-for-unit-tests-0123456789";
  const proof = (ip: string) =>
    createHmac("sha256", EDGE_SECRET).update(ip).digest("hex");
  const edgeHeaders = (ip: string, extra: Record<string, string> = {}) =>
    new Headers({
      "cf-connecting-ip": ip,
      "x-bloomcore-edge-auth": proof(ip),
      ...extra,
    });

  it("prefers the edge-proven cf-connecting-ip", () => {
    vi.stubEnv("TRUSTED_PROXY_HEADERS", "true");
    vi.stubEnv("EDGE_PROXY_SECRET", EDGE_SECRET);
    delete process.env.TRUST_TRUE_CLIENT_IP;
    const headers = edgeHeaders("198.51.100.9", {
      "true-client-ip": "203.0.113.7",
      "x-forwarded-for": "1.2.3.4",
      "x-real-ip": "5.6.7.8",
    });
    expect(getClientIp(headers)).toEqual({ ip: "198.51.100.9", source: "cf-connecting-ip" });
  });

  it("rejects a forged cf-connecting-ip without an edge proof", () => {
    vi.stubEnv("TRUSTED_PROXY_HEADERS", "true");
    vi.stubEnv("EDGE_PROXY_SECRET", EDGE_SECRET);
    const headers = new Headers({
      "cf-connecting-ip": "198.51.100.9",
      "x-bloomcore-edge-auth": proof("203.0.113.7"),
    });
    expect(getClientIp(headers)).toEqual({ ip: null, source: "untrusted" });
  });

  it("rejects a proof computed with a different secret", () => {
    vi.stubEnv("TRUSTED_PROXY_HEADERS", "true");
    vi.stubEnv("EDGE_PROXY_SECRET", EDGE_SECRET);
    const forged = createHmac("sha256", "another-test-secret-0123456789abcdef")
      .update("198.51.100.9")
      .digest("hex");
    expect(
      getClientIp(
        new Headers({
          "cf-connecting-ip": "198.51.100.9",
          "x-bloomcore-edge-auth": forged,
        })
      )
    ).toEqual({ ip: null, source: "untrusted" });
  });

  it("ignores a forged true-client-ip by default", () => {
    vi.stubEnv("TRUSTED_PROXY_HEADERS", "true");
    vi.stubEnv("EDGE_PROXY_SECRET", EDGE_SECRET);
    delete process.env.TRUST_TRUE_CLIENT_IP;
    const result = getClientIp(new Headers({ "true-client-ip": "203.0.113.7" }));
    expect(result).toEqual({ ip: null, source: "untrusted" });
  });

  it("uses true-client-ip only when an operator opts in AND the edge proves it", () => {
    vi.stubEnv("TRUSTED_PROXY_HEADERS", "true");
    vi.stubEnv("TRUST_TRUE_CLIENT_IP", "true");
    vi.stubEnv("EDGE_PROXY_SECRET", EDGE_SECRET);
    const ip = "203.0.113.7";
    expect(
      getClientIp(
        new Headers({
          "true-client-ip": ip,
          "x-bloomcore-edge-auth": proof(ip),
        })
      )
    ).toEqual({ ip, source: "true-client-ip" });
  });

  it("never derives identity from a forwarded chain", () => {
    vi.stubEnv("TRUSTED_PROXY_HEADERS", "true");
    vi.stubEnv("EDGE_PROXY_SECRET", EDGE_SECRET);
    const result = getClientIp(
      new Headers({
        "x-forwarded-for": "1.2.3.4",
        "x-real-ip": "5.6.7.8",
        forwarded: "for=9.9.9.9",
        "cf-connecting-ip": "198.51.100.9",
      })
    );
    expect(result.ip).toBeNull();
  });

  it("treats everything as untrusted without a configured edge secret", () => {
    vi.stubEnv("TRUSTED_PROXY_HEADERS", "true");
    vi.stubEnv("EDGE_PROXY_SECRET", "");
    expect(getClientIp(edgeHeaders("198.51.100.9"))).toEqual({
      ip: null,
      source: "untrusted",
    });
  });

  it("treats everything as untrusted without a trusted proxy", () => {
    vi.stubEnv("TRUSTED_PROXY_HEADERS", "false");
    delete process.env.RENDER;
    delete process.env.RENDER_SERVICE_ID;
    expect(getClientIp(edgeHeaders("9.9.9.9"))).toEqual({
      ip: null,
      source: "untrusted",
    });
  });
});

describe("SEC-05 origin allow-list cannot be widened by headers", () => {
  function request(origin: string | null, forwardedHost?: string) {
    const headers = new Headers();
    if (origin) headers.set("origin", origin);
    if (forwardedHost) headers.set("x-forwarded-host", forwardedHost);
    return new NextRequest(new URL("https://maacash.bloomcoretech.com/api/offline/enroll"), {
      headers,
    });
  }

  it("accepts the canonical origin", () => {
    vi.stubEnv("NEXTAUTH_URL", "https://maacash.bloomcoretech.com");
    vi.stubEnv("TRUSTED_PROXY_HEADERS", "true");
    expect(isSameOriginRequest(request("https://maacash.bloomcoretech.com"))).toBe(true);
  });

  it("rejects an attacker origin even with a matching forged X-Forwarded-Host", () => {
    vi.stubEnv("NEXTAUTH_URL", "https://maacash.bloomcoretech.com");
    vi.stubEnv("TRUSTED_PROXY_HEADERS", "true");
    expect(
      isSameOriginRequest(request("https://evil.example", "evil.example"))
    ).toBe(false);
  });

  it("rejects a missing Origin without same-origin fetch metadata", () => {
    expect(isSameOriginRequest(request(null))).toBe(false);
  });
});

describe("SEC-09 static-asset exemption is a closed list", () => {
  it("keeps real framework and static assets", () => {
    for (const path of [
      "/_next/static/chunk.js",
      "/_next/image",
      "/favicon.ico",
      "/robots.txt",
      "/logo.svg",
      "/branding/maacash-logo.svg",
    ]) {
      expect(isStaticAssetPath(path)).toBe(true);
    }
  });

  it("refuses dotted protected paths", () => {
    for (const path of [
      "/admin/staff/foo.bar",
      "/admin/reports/2026.11.15",
      "/admin/staff/jane.doe",
      "/worker/daily/a.b",
      "/api/auth/session.json.evil",
      "/collector/customers/1.2.3.4",
      "/admin/staff/report.json",
      "/admin/report.pdf",
      "/susu/admin/data.css",
    ]) {
      expect(isStaticAssetPath(path)).toBe(false);
    }
  });

  it("blocks dotted staff and report paths through the middleware", async () => {
    for (const path of ["/admin/staff/foo.bar", "/admin/reports/2026.11.15"]) {
      const response = await middleware(
        new NextRequest(new URL(`https://maacash.bloomcoretech.com${path}`))
      );
      expect(response.status).toBeGreaterThanOrEqual(300);
      expect(response.status).toBeLessThan(400);
    }
  });

  it("still serves static assets through the middleware", async () => {
    for (const path of ["/_next/static/chunk.js", "/favicon.ico"]) {
      const response = await middleware(
        new NextRequest(new URL(`https://maacash.bloomcoretech.com${path}`))
      );
      expect(response.status).toBeLessThan(300);
    }
  });
});

describe("SEC-10 public health endpoints disclose nothing", () => {
  it("returns only a status from the liveness probe", async () => {
    const response = await healthGet();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toEqual({ status: "ok" });
    expect(Object.keys(body)).toHaveLength(1);
  });

  it("returns only a status from the readiness probe", async () => {
    const response = await readyGet();
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body).toEqual({ status: "ready" });
  });

  it("fails closed with 503 and no internals when the database is unavailable", async () => {
    vi.spyOn(db, "$queryRaw").mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.1:5432"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await readyGet();
    const body = await response.json();
    expect(response.status).toBe(503);
    expect(body).toEqual({ status: "not_ready" });
    expect(JSON.stringify(body)).not.toMatch(/ECONNREFUSED|5432|neon|postgres/i);
    expect(errorLog).toHaveBeenCalled();
  });
});

describe("SEC-06 remittance money rules", () => {
  const valid = [
    [1, 1],
    [0.01, 0.01],
    [125.5, 125.5],
    [199.99, 199.99],
    [1_000_000, 1_000_000],
  ] as const;

  it("accepts exact positive money values and normalises them", () => {
    for (const [input, expected] of valid) {
      expect(validateRemittanceAmount(input)).toEqual({ ok: true, value: expected });
    }
  });

  it("rejects NaN, Infinity, strings, negatives, zero, precision and overflow", () => {
    for (const input of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      "100",
      -1,
      0,
      0.001,
      10.005,
      1_000_000.01,
      null,
      undefined,
      {},
    ]) {
      expect(validateRemittanceAmount(input).ok).toBe(false);
    }
  });

  it("excludes reversed contributions from the expected amount", () => {
    const rows = [
      { amount: 100, reversedAt: null },
      { amount: 50, reversedAt: new Date() },
      { amount: 25.5, reversedAt: null },
    ];
    expect(expectedRemittanceAmount(rows)).toBe(125.5);
    expect(expectedRemittanceAmount([])).toBe(0);
  });

  it("records remittances inside a locked transaction and filters reversed rows", () => {
    const source = read("src/lib/actions/susu-collector.actions.ts");
    const start = source.indexOf("export async function recordRemittance");
    const block = source.slice(start, source.indexOf("export async function reverseRemittance"));
    expect(block).toContain("validateRemittanceAmount");
    expect(block).toContain("await db.$transaction(async (tx)");
    expect(block).toContain("lockAccountForUpdate(tx, `collector-remittance:${collectorId}`)");
    expect(block).toContain("reversedAt: null");
    expect(block).toContain("finance:remittance_record");
  });
});

describe("SEC-12 environment files are ignored", () => {
  const root = process.cwd();
  function ignored(file: string): boolean {
    try {
      execFileSync("git", ["check-ignore", "-q", file], { cwd: root, stdio: "pipe" });
      return true;
    } catch {
      return false;
    }
  }

  it("ignores every dotenv variant and credential file", () => {
    for (const file of [
      ".env",
      ".env.local",
      ".env.production",
      ".env.production.local",
      ".env.staging",
      ".env.test",
      ".env.pilot",
      ".secrets/prod.env",
      "credentials.json",
      "deploy.pem",
    ]) {
      expect(ignored(path.join(file))).toBe(true);
    }
  });

  it("still allows templates to be tracked", () => {
    expect(ignored(".env.example")).toBe(false);
    expect(ignored(".env.production.example")).toBe(false);
  });
});
