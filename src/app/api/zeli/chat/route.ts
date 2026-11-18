import { NextRequest, NextResponse } from "next/server";
import { getTenantContext } from "@/lib/tenant";
import { runZeliTurn, ZeliUsageError } from "@/lib/zeli/service";
import { isSameOriginRequest, crossOriginDenied } from "@/lib/security/same-origin";
import type { ZeliIdentity } from "@/lib/zeli/types";
import {
  getZeliAvailability,
  getTenantZeliAccess,
  zeliUnavailableResponse,
  TENANT_DISABLED_MESSAGE,
} from "@/lib/zeli/availability";

async function identity(): Promise<ZeliIdentity | null> {
  for (const moduleName of ["admin", "momo", "susu", "customer"] as const) {
    const ctx = await getTenantContext(moduleName);
    if (ctx) {
      return {
        userId: ctx.userId,
        fullName: "",
        role: ctx.role as ZeliIdentity["role"],
        tenantId: ctx.tenantId,
        module: moduleName,
      };
    }
  }
  return null;
}

/**
 * POST /api/zeli/chat
 * Runs one authorized Zeli turn and streams the already-grounded answer text.
 * Generation is server-side; the client cannot choose a provider, tenant or tool.
 */
export async function POST(request: NextRequest) {
  const availability = await getZeliAvailability();
  if (!availability.enabled) return zeliUnavailableResponse();
  if (!isSameOriginRequest(request)) return crossOriginDenied();
  const who = await identity();
  if (!who) return NextResponse.json({ error: "Not authenticated" }, { status: 401 });

  // Per-business switch. The run itself re-checks it, so disabling Zeli takes
  // effect even if a browser keeps a page open.
  const tenantAccess = await getTenantZeliAccess(who.tenantId);
  if (!tenantAccess.enabled) {
    return NextResponse.json(
      { error: TENANT_DISABLED_MESSAGE, code: "zeli_tenant_disabled" },
      { status: 403, headers: { "cache-control": "no-store" } }
    );
  }

  let body: { conversationId?: string; message?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request" }, { status: 400 });
  }
  if (!body.conversationId || typeof body.message !== "string") {
    return NextResponse.json({ error: "Conversation and message are required" }, { status: 400 });
  }

  let result;
  try {
    result = await runZeliTurn({
      identity: who,
      conversationId: body.conversationId,
      question: body.message,
    });
  } catch (error) {
    if (error instanceof ZeliUsageError) {
      return NextResponse.json({ error: error.message }, { status: 429 });
    }
    return NextResponse.json(
      { error: "Zeli could not complete that request. No data was changed." },
      { status: 400 }
    );
  }

  // The answer is already complete. Send it once: there is deliberately no
  // artificial "typing" animation that would imply a live model is thinking.
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(result.text));
      controller.close();
    },
  });

  // The response carries the answer only. Provider, model and policy details
  // stay server-side so no customer-visible payload names the AI backend.
  return new Response(stream, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-zeli-intent": result.intent,
      "x-zeli-context-used": String(result.contextUsed),
    },
  });
}
