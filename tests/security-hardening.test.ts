import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma, cleanDatabase } from "./setup";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import {
  accountThrottleKey,
  clearThrottle,
  pairThrottleKey,
  readThrottle,
  registerFailure,
} from "@/lib/security/login-throttle";
import { getClientIp } from "@/lib/security/client-ip";
import { verifyTurnstile } from "@/lib/security/turnstile";
import {
  base32Encode,
  consumeRecoveryCode,
  generateRecoveryCodes,
  hashRecoveryCode,
  totpCode,
  verifyTotp,
} from "@/lib/security/totp";
import { requestPasswordReset } from "@/lib/actions/password-recovery.actions";

const BASE = Date.UTC(2026, 0, 15, 12, 0, 0);

beforeEach(async () => {
  await cleanDatabase();
  vi.stubEnv("TURNSTILE_ENABLED", "false");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("persistent rate limiting", () => {
  it("allows the limit, blocks the next request and survives a fresh call", async () => {
    const policy = { limit: 3, windowMs: 60_000 };
    for (let i = 0; i < 3; i++) {
      const result = await consumeRateLimit("test", "user@example.com", policy, BASE);
      expect(result.allowed).toBe(true);
    }
    const blocked = await consumeRateLimit(
      "test",
      "user@example.com",
      policy,
      BASE + 10
    );
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);

    // A separate module instance / process reads the same database row.
    const stored = await prisma.rateLimitCounter.findFirst();
    expect(stored?.count).toBe(4);

    // A new window resets the counter.
    const afterWindow = await consumeRateLimit(
      "test",
      "user@example.com",
      policy,
      BASE + 61_000
    );
    expect(afterWindow.allowed).toBe(true);
  });

  it("stores only keyed identifiers, never the raw email", async () => {
    await consumeRateLimit("test", "secret@example.com", { limit: 5, windowMs: 1000 }, BASE);
    const rows = await prisma.rateLimitCounter.findMany();
    expect(rows.length).toBe(1);
    expect(rows[0].key).not.toContain("secret@example.com");
    expect(rows[0].key).toMatch(/^test:[0-9a-f]{64}$/);
  });
});

describe("progressive failed-login cooldown", () => {
  const keys = () => [
    accountThrottleKey("person@example.com"),
    pairThrottleKey("person@example.com", "203.0.113.10"),
  ];

  it("applies 1 minute, 5 minutes and 15 minutes in order", async () => {
    let now = BASE;
    // Threshold 1: five failures -> 1 minute.
    for (let i = 0; i < 5; i++) {
      await registerFailure(keys(), now);
      now += 1;
    }
    let state = await readThrottle(pairThrottleKey("person@example.com", "203.0.113.10"), now);
    expect(state.blocked).toBe(true);
    expect(state.retryAfterSeconds).toBeLessThanOrEqual(60);
    expect(state.retryAfterSeconds).toBeGreaterThan(55);

    // Attempts during the cooldown must not extend it.
    const blockedUntilBefore = (
      await prisma.authThrottle.findUnique({
        where: { key: pairThrottleKey("person@example.com", "203.0.113.10") },
      })
    )?.blockedUntil?.getTime();
    await registerFailure(keys(), now + 1000);
    const blockedUntilAfter = (
      await prisma.authThrottle.findUnique({
        where: { key: pairThrottleKey("person@example.com", "203.0.113.10") },
      })
    )?.blockedUntil?.getTime();
    expect(blockedUntilAfter).toBe(blockedUntilBefore);

    // After the first cooldown, three more failures reach stage 2 (5 minutes).
    now += 61_000;
    for (let i = 0; i < 3; i++) {
      await registerFailure(keys(), now);
      now += 1;
    }
    state = await readThrottle(pairThrottleKey("person@example.com", "203.0.113.10"), now);
    expect(state.blocked).toBe(true);
    expect(state.retryAfterSeconds).toBeGreaterThan(240);
    expect(state.retryAfterSeconds).toBeLessThanOrEqual(300);

    // Three more reach stage 3 (15 minutes).
    now += 301_000;
    for (let i = 0; i < 3; i++) {
      await registerFailure(keys(), now);
      now += 1;
    }
    state = await readThrottle(pairThrottleKey("person@example.com", "203.0.113.10"), now);
    expect(state.blocked).toBe(true);
    expect(state.retryAfterSeconds).toBeGreaterThan(840);
    expect(state.retryAfterSeconds).toBeLessThanOrEqual(900);
  });

  it("a successful authentication clears the progression", async () => {
    for (let i = 0; i < 5; i++) {
      await registerFailure(keys(), BASE + i);
    }
    expect((await readThrottle(keys()[1], BASE + 10)).blocked).toBe(true);
    await clearThrottle(keys());
    expect((await readThrottle(keys()[1], BASE + 10)).blocked).toBe(false);
  });
});

describe("client IP extraction", () => {
  it("ignores spoofed forwarding headers when no trusted proxy is configured", () => {
    vi.stubEnv("TRUSTED_PROXY_HEADERS", "false");
    const headers = new Headers({
      "x-forwarded-for": "1.2.3.4",
      "x-real-ip": "5.6.7.8",
      "cf-connecting-ip": "9.9.9.9",
    });
    expect(getClientIp(headers)).toEqual({ ip: null, source: "untrusted" });
  });

  it("uses the platform-set headers and never the X-Forwarded-For chain", () => {
    vi.stubEnv("TRUSTED_PROXY_HEADERS", "true");
    const headers = new Headers({
      "x-forwarded-for": "1.2.3.4, 10.0.0.1",
      "true-client-ip": "203.0.113.7",
      "cf-connecting-ip": "198.51.100.9",
    });
    expect(getClientIp(headers)).toEqual({
      ip: "203.0.113.7",
      source: "true-client-ip",
    });
  });

  it("rejects a malformed trusted header", () => {
    vi.stubEnv("TRUSTED_PROXY_HEADERS", "true");
    const result = getClientIp(
      new Headers({ "true-client-ip": "not-an-ip", "x-forwarded-for": "1.2.3.4" })
    );
    expect(result.ip).toBeNull();
  });
});

describe("Cloudflare Turnstile verification", () => {
  const configured = () => {
    vi.stubEnv("TURNSTILE_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "test-site-key");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "test-secret-key");
    vi.stubEnv("TURNSTILE_ALLOWED_HOSTNAMES", "bloomcore-one.onrender.com");
  };

  const response = (overrides: Record<string, unknown> = {}) => ({
    success: true,
    hostname: "bloomcore-one.onrender.com",
    action: "login",
    challenge_ts: new Date(BASE).toISOString(),
    ...overrides,
  });

  it("rejects a missing token", async () => {
    configured();
    const result = await verifyTurnstile({ token: null, action: "login", now: BASE });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("missing");
  });

  it("rejects a token for another action and another hostname", async () => {
    configured();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(response()), { status: 200 }))
    );
    const wrongAction = await verifyTurnstile({
      token: "token-action",
      action: "admin_login",
      now: BASE,
    });
    expect(wrongAction.reason).toBe("action");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify(response({ hostname: "evil.example" })), {
          status: 200,
        })
      )
    );
    const wrongHost = await verifyTurnstile({
      token: "token-host",
      action: "login",
      now: BASE,
    });
    expect(wrongHost.reason).toBe("hostname");
  });

  it("rejects a replayed token, accepts it once, and fails closed on timeout", async () => {
    configured();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(response()), { status: 200 }))
    );
    const first = await verifyTurnstile({
      token: "one-time-token",
      action: "login",
      now: BASE,
    });
    expect(first.ok).toBe(true);

    const replay = await verifyTurnstile({
      token: "one-time-token",
      action: "login",
      now: BASE,
    });
    expect(replay.reason).toBe("replay");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("upstream timeout");
      })
    );
    const down = await verifyTurnstile({
      token: "another-token",
      action: "login",
      now: BASE,
    });
    expect(down.ok).toBe(false);
    expect(down.reason).toBe("unavailable");
  });

  it("fails closed when enabled without keys", async () => {
    vi.stubEnv("TURNSTILE_ENABLED", "true");
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "");
    const result = await verifyTurnstile({ token: "x", action: "login", now: BASE });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("configuration");
  });
});

describe("TOTP and recovery codes", () => {
  it("matches the RFC 6238 SHA-1 test vector (6-digit truncation)", () => {
    const secret = Buffer.from("12345678901234567890", "ascii");
    const encoded = base32Encode(secret);
    expect(totpCode(encoded, 59_000)).toBe("287082");
    expect(verifyTotp(encoded, "287082", 59_000)).toBe(true);
    expect(verifyTotp(encoded, "287083", 59_000)).toBe(false);
  });

  it("consumes each recovery code exactly once", () => {
    const codes = generateRecoveryCodes(3);
    let stored: string | null = JSON.stringify(codes.map(hashRecoveryCode));
    const first = consumeRecoveryCode(stored, codes[0]);
    expect(first.ok).toBe(true);
    stored = first.remaining;
    const reused = consumeRecoveryCode(stored, codes[0]);
    expect(reused.ok).toBe(false);
    const second = consumeRecoveryCode(stored, codes[2]);
    expect(second.ok).toBe(true);
  });
});

describe("password recovery", () => {
  it("never returns a reset token to the caller", async () => {
    vi.stubEnv("TURNSTILE_ENABLED", "false");
    const user = await prisma.user.create({
      data: {
        email: `reset-${Date.now()}@example.com`,
        fullName: "Reset Test",
        role: "worker",
        status: "active",
        passwordHash: "$2b$12$Liry.nw.u149hj.S6S6JfexTBF7uu1EZY8StKjQTA39/jdAco3ZLK",
      },
    });
    const result = await requestPasswordReset(user.email);
    expect(result.success).toBe(true);
    expect(Object.keys(result)).toEqual(["success"]);
    expect(JSON.stringify(result)).not.toContain("_pilotToken");
    const token = await prisma.passwordResetToken.findFirst({
      where: { userId: user.id },
    });
    expect(token).not.toBeNull();
  });
});
