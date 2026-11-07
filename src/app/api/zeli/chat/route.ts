import { NextRequest, NextResponse } from "next/server";
import { getTenantContext } from "@/lib/tenant";
import { runZeliTurn, ZeliUsageError } from "@/lib/zeli/service";
import { isSameOriginRequest, crossOriginDenied } from "@/lib/security/same-origin";
import type { ZeliIdentity } from "@/lib/zeli/types";
import { getZeliAvailability, zeliUnavailableResponse } from "@/lib/zeli/availability";
import { getEffectiveProviderPolicy } from "@/lib/zeli/provider-control";
import { providerPolicyHeaders } from "@/lib/zeli/provider-status";
import { getConversationStatus } from "@/lib/zeli/providers/conversation-provider";

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

  // Informational only. The local assistant stays available regardless: this
  // header describes whether external AI may be called, not whether Zeli works.
  // It is never used to authorize anything; the provider path re-checks policy.
  const externalAiHeaders = providerPolicyHeaders(
    await getEffectiveProviderPolicy(who.tenantId, who.userId)
  );
  const conversationStatus = await getConversationStatus(who.tenantId, who.userId);

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

  return new Response(stream, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-zeli-provider": result.provider,
      "x-zeli-provider-available": String(result.providerAvailable),
      "x-zeli-provider-kind": result.externalAi
        ? "external-conversational"
        : "internal-deterministic",
      "x-zeli-conversation-mode": result.conversationMode,
      "x-zeli-conversation-provider": result.externalAi
        ? result.provider
        : "internal",
      "x-zeli-intent": result.intent,
      "x-zeli-context-used": String(result.contextUsed),
      ...externalAiHeaders,
      ...(conversationStatus.mode === "external"
        ? {}
        : { "x-zeli-conversation-status": "local-only" }),
    },
  });
}
