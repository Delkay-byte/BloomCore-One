/**
 * Zeli anomaly triage — deterministic scoring and tenant-scoped briefing.
 *
 * The score exists to order review. It must never be described as a
 * probability, and the provider must disclose that no model was used.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { SignJWT } from "jose";
import { prisma, cleanDatabase, createTestAdmin } from "./setup";
import {
  buildAnomalyTriage,
  getAnomalyScoringProvider,
  triageBand,
  type AnomalyTriageSignal,
} from "@/lib/zeli/anomaly-detection";

const { mockCookieStore } = vi.hoisted(() => ({
  mockCookieStore: new Map<string, string>(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      mockCookieStore.has(name)
        ? { name, value: mockCookieStore.get(name)! }
        : undefined,
    set: (name: string, value: string) => mockCookieStore.set(name, value),
    delete: (name: string) => mockCookieStore.delete(name),
  }),
  headers: async () => new Headers(),
}));
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { getZeliAnomalyBriefing } from "@/lib/actions/zeli-anomaly.actions";

const JWT_SECRET = new TextEncoder().encode("test-secret-for-vitest");
const NOW = new Date("2026-12-05T12:00:00Z");

async function setAdminSession(user: { id: string; email: string }) {
  const now = Math.floor(Date.now() / 1000);
  mockCookieStore.clear();
  mockCookieStore.set(
    "bik-admin-session",
    await new SignJWT({
      userId: user.id,
      email: user.email,
      fullName: "Test",
      role: "admin",
      modules: ["momo"],
      tokenVersion: 0,
      lastActivityAt: now,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now)
      .setExpirationTime("1h")
      .sign(JWT_SECRET)
  );
}

function signal(overrides: Partial<AnomalyTriageSignal> = {}): AnomalyTriageSignal {
  return {
    id: `finding-${Math.random().toString(36).slice(2, 8)}`,
    ruleKey: "daily_shortage",
    severity: "medium",
    status: "open",
    workerId: "worker-1",
    workerName: "Ama Worker",
    locationId: "location-1",
    locationName: "Main Branch",
    detectedAt: "2026-12-04T10:00:00.000Z",
    ...overrides,
  };
}

describe("deterministic anomaly triage", () => {
  it("returns a zero score and an explicit no-findings headline", () => {
    const briefing = buildAnomalyTriage([], NOW);
    expect(briefing.score).toBe(0);
    expect(briefing.band).toBe("low");
    expect(briefing.groups).toHaveLength(0);
    expect(briefing.headline).toBe("No active findings to triage.");
    expect(briefing.modelUsed).toBe(false);
    expect(briefing.externalModel).toBe(false);
  });

  it("uses fixed weights and places a single high finding in the elevated band", () => {
    const briefing = buildAnomalyTriage(
      [signal({ severity: "high" })],
      NOW
    );
    expect(briefing.score).toBe(42);
    expect(briefing.band).toBe("elevated");
    expect(triageBand(42)).toBe("elevated");
    expect(triageBand(70)).toBe("high");
    expect(triageBand(34.9)).toBe("low");
  });

  it("raises the score for repeats and caps it at 100", () => {
    const repeated = buildAnomalyTriage(
      [
        signal({ severity: "medium" }),
        signal({ severity: "medium" }),
        signal({ severity: "medium" }),
      ],
      NOW
    );
    expect(repeated.score).toBe(76); // 60 + 16
    expect(repeated.band).toBe("high");
    expect(repeated.groups[0].reasons.join(" ")).toMatch(/Repeated findings/);

    const capped = buildAnomalyTriage(
      Array.from({ length: 8 }, () => signal({ severity: "high" })),
      NOW
    );
    expect(capped.score).toBe(100);
    expect(capped.band).toBe("high");
  });

  it("groups by employee first, then branch, and ignores resolved findings", () => {
    const briefing = buildAnomalyTriage(
      [
        signal({ workerId: "w1", workerName: "Ama", severity: "high" }),
        signal({ workerId: "w1", workerName: "Ama", severity: "low" }),
        signal({
          workerId: null,
          workerName: null,
          locationId: "loc-1",
          locationName: "Kaneshie",
          severity: "medium",
        }),
        signal({
          workerId: null,
          locationId: null,
          status: "resolved",
          severity: "high",
        }),
      ],
      NOW
    );
    expect(briefing.signalsConsidered).toBe(3);
    expect(briefing.groups.map((group) => group.kind)).toEqual([
      "employee",
      "branch",
    ]);
    expect(briefing.groups[0].label).toBe("Ama");
    expect(briefing.groups[0].signalCount).toBe(2);
    expect(briefing.groups[1].label).toBe("Kaneshie");
  });

  it("advertises itself as the deterministic provider with no external model", () => {
    const provider = getAnomalyScoringProvider();
    expect(provider.id).toBe("deterministic_rules");
    expect(provider.externalModel).toBe(false);
    const briefing = provider.score([signal({ severity: "low" })], NOW);
    expect(briefing.modelUsed).toBe(false);
    expect(briefing.externalModel).toBe(false);
    expect(briefing.provider).toBe("deterministic_rules");
  });
});

describe("Zeli anomaly briefing action", () => {
  beforeEach(async () => {
    mockCookieStore.clear();
    await cleanDatabase();
  });

  async function createFinding(input: {
    tenantId: string;
    workerId?: string | null;
    locationId?: string | null;
    severity?: string;
    status?: string;
    fingerprint: string;
  }) {
    return prisma.operationalAnomaly.create({
      data: {
        tenantId: input.tenantId,
        fingerprint: input.fingerprint,
        ruleKey: "daily_shortage",
        severity: input.severity ?? "medium",
        status: input.status ?? "open",
        title: "Cash shortage on a reconciled day",
        summary: "Test finding",
        entityType: "dailyAccount",
        entityId: `account-${input.fingerprint}`,
        workerId: input.workerId ?? null,
        locationId: input.locationId ?? null,
      },
    });
  }

  it("returns only this tenant's active findings with resolved names", async () => {
    const admin = await createTestAdmin();
    const other = await createTestAdmin();
    const worker = await prisma.user.create({
      data: {
        tenantId: admin.tenantId!,
        email: `worker-${Math.random().toString(36).slice(2, 8)}@test.local`,
        fullName: "Akosua Mensah",
        role: "worker",
        status: "active",
        passwordHash: "x",
      },
    });
    const location = await prisma.location.create({
      data: {
        tenantId: admin.tenantId!,
        name: "Kaneshie Branch",
        code: `LOC-${Math.random().toString(36).slice(2, 8)}`,
      },
    });

    await createFinding({
      tenantId: admin.tenantId!,
      workerId: worker.id,
      locationId: location.id,
      severity: "high",
      fingerprint: "own-open",
    });
    await createFinding({
      tenantId: admin.tenantId!,
      workerId: worker.id,
      severity: "high",
      status: "resolved",
      fingerprint: "own-resolved",
    });
    await createFinding({
      tenantId: other.tenantId!,
      severity: "high",
      fingerprint: "other-open",
    });

    await setAdminSession(admin);
    const result = await getZeliAnomalyBriefing();
    expect(result.success).toBe(true);
    expect(result.data?.signalsConsidered).toBe(1);
    expect(result.data?.groups).toHaveLength(1);
    expect(result.data?.groups[0].label).toBe("Akosua Mensah");
    expect(result.data?.groups[0].kind).toBe("employee");
    expect(result.data?.groups[0].high).toBe(1);
    expect(result.data?.score).toBe(42);
  });
});
