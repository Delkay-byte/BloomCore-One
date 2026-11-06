import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { runZeliTurn } from "@/lib/zeli/service";
import type { ZeliIdentity } from "@/lib/zeli/types";

/**
 * Staging-only acceptance probe.
 *
 * Purpose: prove that the deployed staging application can hold a real
 * Enhanced-AI conversation with the actual provider and the actual read-only
 * business tools, using only synthetic data.
 *
 * Guards:
 *  - APP_ENV must be STAGING;
 *  - ZELI_ACCEPTANCE_PROBE must be "enabled";
 *  - a 32+ byte token must match ZELI_ACCEPTANCE_PROBE_TOKEN;
 *  - the identity is a fixed synthetic admin resolved from
 *    ZELI_ACCEPTANCE_TENANT_CODE, never from the request;
 *  - the questions are fixed and contain no user input;
 *  - the response contains metadata only: no answer text and no business data.
 *
 * This route is removed after the acceptance window.
 */

const TURNS = [
  "Hello. What can you help me with?",
  "Give me a summary of the business this month.",
  "What about last month?",
];

const hits = new Map<string, { count: number; resetAt: number }>();

function limited(ip: string): boolean {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || entry.resetAt < now) {
    hits.set(ip, { count: 1, resetAt: now + 60_000 });
    return false;
  }
  entry.count += 1;
  return entry.count > 6;
}

function tokenMatches(provided: string | null, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

async function probeIdentity(): Promise<ZeliIdentity | null> {
  const code = (process.env.ZELI_ACCEPTANCE_TENANT_CODE || "").trim();
  if (!code) return null;
  const tenant = await db.businessTenant.findFirst({
    where: { code, status: "ACTIVE" },
    select: { id: true, name: true, code: true },
  });
  if (!tenant) return null;
  if (!/staging|synthetic|demo|test/i.test(tenant.name)) return null;
  const admin = await db.user.findFirst({
    where: { tenantId: tenant.id, role: "admin", status: "active" },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  });
  if (!admin) return null;
  return {
    userId: admin.id,
    fullName: "Synthetic Acceptance Admin",
    role: "admin",
    tenantId: tenant.id,
    module: "admin",
  };
}

export async function POST(request: NextRequest) {
  if ((process.env.APP_ENV || "").toUpperCase() !== "STAGING") {
    return new NextResponse(null, { status: 404 });
  }
  if (process.env.ZELI_ACCEPTANCE_PROBE !== "enabled") {
    return new NextResponse(null, { status: 404 });
  }
  const token = process.env.ZELI_ACCEPTANCE_PROBE_TOKEN || "";
  if (token.length < 32 || !tokenMatches(request.headers.get("x-zeli-probe-token"), token)) {
    return new NextResponse(null, { status: 404 });
  }

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  if (limited(ip)) {
    return NextResponse.json({ error: "probe_rate_limited" }, { status: 429 });
  }

  const identity = await probeIdentity();
  if (!identity) {
    return NextResponse.json({ error: "probe_identity_unavailable" }, { status: 503 });
  }

  const conversation =
    (await db.zeliConversation.findFirst({
      where: {
        tenantId: identity.tenantId,
        userId: identity.userId,
        title: "SYNTHETIC ACCEPTANCE PROBE",
        deletedAt: null,
      },
      orderBy: { updatedAt: "desc" },
    })) ??
    (await db.zeliConversation.create({
      data: {
        tenantId: identity.tenantId,
        userId: identity.userId,
        title: "SYNTHETIC ACCEPTANCE PROBE",
      },
    }));

  const turns = [];
  for (const question of TURNS) {
    const started = Date.now();
    try {
      const result = await runZeliTurn({
        identity,
        conversationId: conversation.id,
        question,
      });
      turns.push({
        ok: true,
        mode: result.conversationMode,
        provider: result.provider,
        model: result.model,
        intent: result.intent,
        tools: result.tools.map((tool) => ({ tool: tool.tool, ok: tool.ok })),
        numericIntegrity: result.numericIntegrity,
        contextUsed: result.contextUsed,
        period: result.period,
        latencyMs: Date.now() - started,
        answerChars: result.text.length,
      });
    } catch (error) {
      turns.push({
        ok: false,
        error: error instanceof Error ? error.name : "unknown_error",
        latencyMs: Date.now() - started,
      });
    }
  }

  return NextResponse.json(
    {
      environment: "staging",
      tenantCode: process.env.ZELI_ACCEPTANCE_TENANT_CODE,
      turns,
    },
    { headers: { "cache-control": "no-store" } }
  );
}
