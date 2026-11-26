/**
 * Consent proof for customer messaging.
 *
 * A number typed into the customer portal is only a claim. Before it can
 * receive receipts it must be proven: a six-digit code is sent to that number,
 * stored only as a hash, expires, is single-use and has a bounded attempt count.
 * Until then the preference stays `unverified`, and `channelConsented` (which
 * every receipt path uses) refuses it.
 *
 * The code itself is never written to the outbox and never logged: the outbox
 * payload rule forbids OTPs, so proof messages are sent through the provider
 * adapter directly and only their masked recipient is recorded.
 */

import { randomInt } from "crypto";
import { db } from "@/lib/db";
import { constantTimeEqual, sha256 } from "@/lib/security/crypto";
import { maskPhone } from "@/lib/messaging/provider";
import { normalizeE164 } from "@/lib/messaging/outbox";
import { getWhatsAppProvider } from "@/lib/messaging/whatsapp";
import { getSmsProvider } from "@/lib/messaging/sms";

export type ConsentChannel = "whatsapp" | "sms";

export const CONSENT_CODE_TTL_MS = 10 * 60 * 1000;
export const CONSENT_MAX_ATTEMPTS = 5;
export const CONSENT_CODE_LENGTH = 6;

export interface ConsentChallengeResult {
  sent: boolean;
  /** `simulated` means the provider accepted the request but cannot deliver. */
  delivery: "accepted" | "simulated" | "failed";
  channel: ConsentChannel;
  maskedNumber: string | null;
  expiresAt: string | null;
  error: string | null;
}

export interface ConsentConfirmationResult {
  verified: boolean;
  error?: string;
  /** Remaining attempts before the challenge must be reissued. */
  attemptsRemaining?: number;
}

function hashCode(customerId: string, channel: ConsentChannel, code: string): string {
  return sha256(`consent:${customerId}:${channel}:${code.trim()}`);
}

function numberFingerprint(number: string): string {
  return sha256(`recipient:${number}`);
}

/** Replace any earlier pending challenge: only the newest code can be used. */
async function supersedePending(customerId: string, channel: ConsentChannel) {
  await db.messagingConsentChallenge.updateMany({
    where: { customerId, channel, status: "pending" },
    data: { status: "superseded", consumedAt: new Date() },
  });
}

async function sendProof(input: {
  channel: ConsentChannel;
  number: string;
  code: string;
  businessName: string;
}): Promise<"accepted" | "simulated" | "failed"> {
  const body = `Your ${input.businessName} confirmation code is ${input.code}. It expires in 10 minutes. If you did not ask for this, ignore this message.`;
  if (input.channel === "sms") {
    const result = await getSmsProvider().sendSms({
      to: input.number,
      body,
      reference: "consent_proof",
    });
    if (result.status === "accepted") return "accepted";
    if (result.status === "simulated") return "simulated";
    return "failed";
  }
  const result = await getWhatsAppProvider().sendTemplate({
    to: input.number,
    templateName: (process.env.WHATSAPP_OTP_TEMPLATE ?? "maacash_consent_code").trim(),
    languageCode: (process.env.WHATSAPP_TEMPLATE_LANGUAGE ?? "en_US").trim(),
    parameters: [input.code],
  });
  if (result.status === "accepted") return "accepted";
  if (result.status === "simulated") return "simulated";
  return "failed";
}

/**
 * Send one proof code to the number the customer wants to opt in with.
 *
 * `deliver` exists so a test can capture the code; the production path uses the
 * provider adapter and never reveals the code to the caller.
 */
export async function issueConsentChallenge(input: {
  tenantId: string;
  customerId: string;
  channel: ConsentChannel;
  number: string;
  businessName: string;
  deliver?: (code: string) => Promise<void>;
  now?: Date;
}): Promise<ConsentChallengeResult> {
  const number = normalizeE164(input.number);
  if (!number) {
    return {
      sent: false,
      delivery: "failed",
      channel: input.channel,
      maskedNumber: null,
      expiresAt: null,
      error: "Enter a valid number with country code.",
    };
  }

  const now = input.now ?? new Date();
  const code = String(randomInt(0, 10 ** CONSENT_CODE_LENGTH)).padStart(
    CONSENT_CODE_LENGTH,
    "0"
  );
  await supersedePending(input.customerId, input.channel);
  const challenge = await db.messagingConsentChallenge.create({
    data: {
      tenantId: input.tenantId,
      customerId: input.customerId,
      channel: input.channel,
      numberHash: numberFingerprint(number),
      numberMasked: maskPhone(number) ?? "[number]",
      codeHash: hashCode(input.customerId, input.channel, code),
      expiresAt: new Date(now.getTime() + CONSENT_CODE_TTL_MS),
    },
  });

  let delivery: "accepted" | "simulated" | "failed";
  if (input.deliver) {
    try {
      await input.deliver(code);
      delivery = "accepted";
    } catch {
      delivery = "failed";
    }
  } else {
    delivery = await sendProof({
      channel: input.channel,
      number,
      code,
      businessName: input.businessName,
    });
  }

  if (delivery === "failed") {
    // A code nobody received must not stay usable: it would allow an attempt
    // against a challenge whose code exists only in this process.
    await db.messagingConsentChallenge.update({
      where: { id: challenge.id },
      data: { status: "superseded", consumedAt: new Date() },
    });
  }

  return {
    sent: delivery !== "failed",
    delivery,
    channel: input.channel,
    maskedNumber: maskPhone(number),
    expiresAt: new Date(now.getTime() + CONSENT_CODE_TTL_MS).toISOString(),
    error:
      delivery === "failed"
        ? "We could not send the confirmation code. Try again in a moment."
        : null,
  };
}

/**
 * Verify a proof code and, on success, mark that channel verified.
 *
 * A wrong code costs one attempt; the challenge dies after the attempt bound or
 * at expiry, so a six-digit code cannot be guessed by repetition.
 */
export async function confirmConsentChallenge(input: {
  tenantId: string;
  customerId: string;
  channel: ConsentChannel;
  code: string;
  now?: Date;
}): Promise<ConsentConfirmationResult> {
  const now = input.now ?? new Date();
  const challenge = await db.messagingConsentChallenge.findFirst({
    where: { customerId: input.customerId, channel: input.channel, status: "pending" },
    orderBy: { createdAt: "desc" },
  });
  if (!challenge || challenge.tenantId !== input.tenantId) {
    return { verified: false, error: "Request a new confirmation code first." };
  }
  if (challenge.expiresAt.getTime() <= now.getTime()) {
    await db.messagingConsentChallenge.update({
      where: { id: challenge.id },
      data: { status: "superseded", consumedAt: now },
    });
    return { verified: false, error: "That code has expired. Request a new one." };
  }
  if (challenge.attempts >= CONSENT_MAX_ATTEMPTS) {
    return {
      verified: false,
      error: "Too many attempts. Request a new confirmation code.",
      attemptsRemaining: 0,
    };
  }

  const expected = hashCode(input.customerId, input.channel, input.code);
  if (!constantTimeEqual(expected, challenge.codeHash)) {
    const attempts = challenge.attempts + 1;
    await db.messagingConsentChallenge.update({
      where: { id: challenge.id },
      data: { attempts },
    });
    return {
      verified: false,
      error: "That code is not correct.",
      attemptsRemaining: Math.max(0, CONSENT_MAX_ATTEMPTS - attempts),
    };
  }

  const preference = await db.customerMessagingPreference.findUnique({
    where: { customerId: input.customerId },
  });
  if (!preference) {
    return { verified: false, error: "Save the number first, then confirm it." };
  }
  const stored =
    input.channel === "whatsapp" ? preference.whatsappNumber : preference.smsNumber;
  if (!stored || numberFingerprint(stored) !== challenge.numberHash) {
    // The number changed between sending and confirming: the proof belongs to a
    // number the customer no longer wants, so it must not verify the new one.
    await db.messagingConsentChallenge.update({
      where: { id: challenge.id },
      data: { status: "superseded", consumedAt: now },
    });
    return {
      verified: false,
      error: "The saved number changed. Request a new confirmation code.",
    };
  }

  await db.$transaction(async (tx) => {
    await tx.messagingConsentChallenge.update({
      where: { id: challenge.id },
      data: { status: "verified", consumedAt: now },
    });
    await tx.customerMessagingPreference.update({
      where: { customerId: input.customerId },
      data:
        input.channel === "whatsapp"
          ? {
              whatsappStatus: "verified",
              whatsappVerifiedAt: now,
              whatsappVerificationMethod: "otp",
              whatsappOptInAt: now,
              whatsappOptOutAt: null,
              whatsappOptInSource: "customer_portal_otp",
            }
          : {
              smsStatus: "verified",
              smsVerifiedAt: now,
              smsVerificationMethod: "otp",
              smsOptInAt: now,
              smsOptOutAt: null,
              smsOptInSource: "customer_portal_otp",
            },
    });
  });

  return { verified: true };
}

/** Whether the preference row proves ownership of the number it will send to. */
export function hasVerifiedNumber(
  preference:
    | {
        whatsappStatus: string;
        whatsappVerifiedAt: Date | null;
        smsStatus: string;
        smsVerifiedAt: Date | null;
      }
    | null
    | undefined
): { whatsapp: boolean; sms: boolean } {
  return {
    whatsapp: Boolean(
      preference?.whatsappStatus === "verified" && preference.whatsappVerifiedAt
    ),
    sms: Boolean(preference?.smsStatus === "verified" && preference.smsVerifiedAt),
  };
}
