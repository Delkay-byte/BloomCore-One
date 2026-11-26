/**
 * Provider failures driven through the real Paystack client using a loopback
 * transport seam. NODE_ENV=test and a loopback URL are both required; production
 * always uses the fixed provider host. No real provider is contacted.
 */
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  lookupTransaction,
  PaystackError,
  paystackBaseUrl,
  verifyTransaction,
} from "@/lib/payments/paystack";

let server: http.Server;
let base = "";

const success = JSON.stringify({
  status: true,
  data: {
    id: 123,
    status: "success",
    reference: "APP-PATH-1",
    amount: 500,
    currency: "GHS",
    paid_at: "2026-11-26T00:00:00.000Z",
    customer: { customer_code: "CUST-1" },
    metadata: {},
  },
});

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const ref = decodeURIComponent((req.url ?? "").split("/").pop() ?? "");
    if (ref === "REJECT") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: false, message: "Invalid reference" }));
      return;
    }
    if (ref === "DUPLICATE") {
      res.writeHead(409, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: false, message: "duplicate reference" }));
      return;
    }
    if (ref === "SERVER_ERROR") {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: false, message: "temporarily unavailable" }));
      return;
    }
    if (ref === "MALFORMED") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{not json");
      return;
    }
    if (ref === "OVERSIZE") {
      res.writeHead(200, { "content-type": "text/plain", "content-length": "300000" });
      res.end("x".repeat(300 * 1024));
      return;
    }
    if (ref === "RESET") {
      req.socket.destroy();
      return;
    }
    if (ref === "DELAYED") {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(success);
      }, 1500);
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(success);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no loopback port");
  base = `http://127.0.0.1:${address.port}`;
  vi.stubEnv("PAYSTACK_BASE_URL", base);
  vi.stubEnv("PAYSTACK_SECRET_KEY", "test-only-synthetic-paystack-key");
}, 30_000);

afterAll(() => {
  vi.unstubAllEnvs();
  server?.close();
});

describe("provider failures through the real Paystack client", () => {
  it("treats a definite 400 rejection as 'not found', not as success", async () => {
    const result = await lookupTransaction("REJECT");
    expect(result.found).toBe(false);
    expect(result.transaction).toBeNull();
  });

  it("keeps duplicate and 5xx answers reconciliation-required (ambiguous)", async () => {
    for (const ref of ["DUPLICATE", "SERVER_ERROR"]) {
      await expect(verifyTransaction(ref)).rejects.toMatchObject({
        failureKind: "ambiguous",
      });
    }
  });

  it("treats malformed, oversized and reset responses as ambiguous failures", async () => {
    for (const ref of ["MALFORMED", "OVERSIZE", "RESET"]) {
      await expect(verifyTransaction(ref)).rejects.toBeInstanceOf(PaystackError);
    }
  });

  it("does not mark a delayed success as paid until verification confirms it", async () => {
    const tx = await verifyTransaction("DELAYED");
    expect(tx.status).toBe("success");
    expect(tx.reference).toBe("APP-PATH-1");
  });

  it("only resolves the seam for a loopback URL in a test runtime", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PAYSTACK_BASE_URL", base);
    expect(paystackBaseUrl()).toBe("https://api.paystack.co");

    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("PAYSTACK_BASE_URL", "https://attacker.example");
    expect(paystackBaseUrl()).toBe("https://api.paystack.co");

    vi.stubEnv("PAYSTACK_BASE_URL", base);
    expect(paystackBaseUrl()).toBe(base);
  });

  it("never leaks the synthetic key or raw provider body into the error", async () => {
    await expect(verifyTransaction("MALFORMED")).rejects.toMatchObject({
      message: expect.not.stringContaining("test-only-synthetic-paystack-key"),
    });
  });
});
