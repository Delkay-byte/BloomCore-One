import type { SusuReceipt } from "@/lib/susu-statements";
import {
  MAX_MESSAGE_LENGTH,
  type MessageChannel,
} from "@/lib/messaging/provider";

function ghs(value: number): string {
  return `GHS ${value.toFixed(2)}`;
}

function date(value: string): string {
  return new Date(value).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Deterministic receipt text. It contains only what the receipt already shows:
 * business, transaction reference, amount and date. It never describes a
 * contribution as profit or as a provider-confirmed balance.
 */
export function buildReceiptMessage(
  receipt: SusuReceipt,
  channel: MessageChannel
): string {
  const isContribution = receipt.kind === "contribution";
  const heading = receipt.isReversal
    ? "Reversal"
    : isContribution
      ? "Contribution received"
      : "Withdrawal paid";
  const amount = ghs(Math.abs(receipt.netAmount));
  const lines =
    channel === "sms"
      ? [
          `${receipt.businessName}: ${heading} ${amount}.`,
          `Ref ${receipt.reference}.`,
          `Date ${date(receipt.issuedAt)}.`,
          "Keep this reference for any query.",
        ]
      : [
          `${receipt.businessName}`,
          `${heading}: ${amount}`,
          `Customer: ${receipt.customer.fullName}`,
          `Account: ${receipt.accountNumber} · Cycle ${receipt.cycleNumber}`,
          `Date: ${date(receipt.issuedAt)}`,
          `Receipt: ${receipt.reference}`,
          isContribution
            ? "Your contribution has been recorded."
            : "Your withdrawal has been recorded and paid.",
          "Keep this receipt reference for any query.",
        ];
  return lines.join(channel === "sms" ? " " : "\n");
}

export function receiptMessageFits(
  receipt: SusuReceipt,
  channel: MessageChannel
): boolean {
  return buildReceiptMessage(receipt, channel).length <= MAX_MESSAGE_LENGTH[channel];
}
