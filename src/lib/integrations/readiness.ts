/**
 * External integration readiness.
 *
 * MaaCash has no approved telco, SMS/WhatsApp delivery or provider-status
 * contract in this repository. These interfaces exist so a future adapter can
 * be added without changing callers, and so the product never pretends a
 * message was delivered or a provider confirmed a transaction.
 *
 * Nothing in this module opens a network connection. The adapters below are
 * deliberately non-delivering: they report `unavailable` or `simulated`.
 */

import { getMessageProvider } from "@/lib/messaging/provider";

export type IntegrationReadinessStatus = "sandbox" | "unavailable";

export interface IntegrationReadiness {
  id: string;
  label: string;
  capability: string;
  status: IntegrationReadinessStatus;
  /** True only when the adapter can act outside MaaCash. */
  delivers: boolean;
  detail: string;
  requiredApprovals: string[];
}

export type TelcoLookupStatus = "unavailable";

export interface TelcoTransactionLookup {
  status: TelcoLookupStatus;
  providerId: string;
  reference: string;
  reason: string;
  /** Always false: no provider confirmed anything. */
  providerConfirmed: false;
}

export interface TelcoProvider {
  readonly id: string;
  readonly delivers: boolean;
  lookupTransaction(reference: string): Promise<TelcoTransactionLookup>;
}

/**
 * Placeholder adapter. It never contacts an aggregator and never returns a
 * confirmed transaction, so `provider_confirmed` remains unproducible.
 */
export class UnavailableTelcoProvider implements TelcoProvider {
  readonly id = "unconfigured";
  readonly delivers = false;

  async lookupTransaction(reference: string): Promise<TelcoTransactionLookup> {
    return {
      status: "unavailable",
      providerId: this.id,
      reference: reference.trim(),
      reason:
        "No telco or aggregator integration is approved or configured. The transaction remains operator-recorded.",
      providerConfirmed: false,
    };
  }
}

export function getTelcoProvider(): TelcoProvider {
  // Fixed until an approved provider contract, credentials and reconciliation
  // process exist. Do not replace this with a live adapter in a feature branch.
  return new UnavailableTelcoProvider();
}

export function getIntegrationReadiness(): IntegrationReadiness[] {
  const messages = getMessageProvider();
  const telco = getTelcoProvider();

  return [
    {
      id: "messaging",
      label: "SMS and WhatsApp",
      capability: "Customer receipt and statement message preview",
      status: "sandbox",
      delivers: messages.delivers,
      detail: messages.delivers
        ? "A delivering adapter is configured."
        : "Sandbox only. Messages are previewed and validated; nothing is transmitted, stored or charged.",
      requiredApprovals: [
        "Provider contract, sender ID and pricing",
        "Consent, opt-out and message-retention rules",
        "Delivery monitoring and failure handling",
      ],
    },
    {
      id: "telco_statement",
      label: "Telco / aggregator statement feed",
      capability: "Independent provider confirmation of MoMo transactions",
      status: telco.delivers ? "sandbox" : "unavailable",
      delivers: telco.delivers,
      detail: telco.delivers
        ? "A telco adapter is configured."
        : "Unavailable. No statement import or provider confirmation exists; every MoMo entry remains operator-recorded.",
      requiredApprovals: [
        "Aggregator or telco API agreement",
        "Statement format, reconciliation and dispute process",
        "Data-protection review for customer transaction data",
      ],
    },
    {
      id: "provider_payment_status",
      label: "Customer payment status",
      capability: "Independent confirmation of customer contributions and withdrawals",
      status: "unavailable",
      delivers: false,
      detail:
        "Unavailable. Paystack is used for MaaCash subscription billing only; it is not a source of truth for customer contributions.",
      requiredApprovals: [
        "Decision on whether customer payments are collected electronically",
        "Provider webhook, signature and replay-handling agreement",
        "Settlement and reconciliation ownership",
      ],
    },
  ];
}
