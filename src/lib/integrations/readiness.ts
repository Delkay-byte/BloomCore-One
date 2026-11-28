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

import { getWhatsAppConfig } from "@/lib/messaging/whatsapp";
import { getSmsProvider, getSmsProviderConfig } from "@/lib/messaging/sms";

/**
 * The only status labels this page may show. A capability has exactly one
 * status, so an unavailable integration can never also look "coming soon".
 */
export type IntegrationReadinessStatus =
  | "available"
  | "sandbox"
  | "not_configured"
  | "unavailable"
  | "coming_soon"
  | "manual_process"
  | "requires_owner_setup";

export interface IntegrationReadiness {
  id: string;
  label: string;
  capability: string;
  status: IntegrationReadinessStatus;
  /** True only when the adapter can act outside MaaCash. */
  delivers: boolean;
  /** One short, owner-facing sentence. No internal terminology. */
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
  const telco = getTelcoProvider();
  const whatsapp = getWhatsAppConfig();
  const sms = getSmsProvider();
  const smsConfig = getSmsProviderConfig();

  const whatsappDelivers = whatsapp.deliveryEnabled && whatsapp.configured;

  return [
    {
      id: "whatsapp",
      label: "WhatsApp receipts",
      capability: "Customer receipt and statement messages over WhatsApp Cloud API",
      status: whatsappDelivers
        ? "sandbox"
        : whatsapp.configured
          ? "unavailable"
          : "requires_owner_setup",
      delivers: whatsappDelivers,
      detail: whatsappDelivers
        ? "Configured with delivery enabled for allowlisted numbers only; approved templates are required."
        : whatsapp.configured
          ? "Credentials are present, but delivery is disabled by policy. Receipts are queued; nothing leaves MaaCash."
          : "Not configured for this deployment. Receipts are previewed and queued; nothing is transmitted or charged.",
      requiredApprovals: [
        "Meta WhatsApp Business account and approved utility templates",
        "Consent, opt-out and message-retention rules",
        "Delivery monitoring and failure handling",
      ],
    },
    {
      id: "sms",
      label: "SMS live delivery",
      capability: "Confirmed contribution and withdrawal receipts by SMS",
      status: sms.delivers ? "sandbox" : smsConfig.provider ? "unavailable" : "not_configured",
      delivers: sms.delivers,
      detail: smsConfig.provider
        ? `SMS_PROVIDER is set to "${smsConfig.provider}", but no reviewed adapter exists. The mock adapter never sends.`
        : "No SMS provider has been selected. Receipts are queued and validated only; nothing is transmitted.",
      requiredApprovals: [
        "Selected SMS provider and sender ID",
        "Per-message pricing and delivery monitoring",
        "Consent, opt-out and retention rules",
      ],
    },
    {
      id: "mtn",
      label: "MTN Mobile Money",
      capability: "Independent MTN confirmation of MoMo float, statements and transactions",
      status: "unavailable",
      delivers: false,
      detail:
        "Transactions are recorded by staff and reconciled against imported CSV statements; no MTN system is contacted.",
      requiredApprovals: [
        "MTN or aggregator API agreement",
        "Statement format, reconciliation and dispute process",
        "Data-protection review for customer transaction data",
      ],
    },
    {
      id: "telecel",
      label: "Telecel Cash",
      capability: "Independent Telecel confirmation of float, statements and transactions",
      status: "unavailable",
      delivers: false,
      detail:
        "Transactions are recorded by staff and reconciled against imported CSV statements; no Telecel system is contacted.",
      requiredApprovals: [
        "Telecel or aggregator API agreement",
        "Statement format, reconciliation and dispute process",
        "Data-protection review for customer transaction data",
      ],
    },
    {
      id: "at_money",
      label: "AT Money",
      capability: "Independent AT Money confirmation of float, statements and transactions",
      status: "unavailable",
      delivers: false,
      detail:
        "Transactions are recorded by staff and reconciled against imported CSV statements; no AT Money system is contacted.",
      requiredApprovals: [
        "AT or aggregator API agreement",
        "Statement format, reconciliation and dispute process",
        "Data-protection review for customer transaction data",
      ],
    },
    {
      id: "banking",
      label: "Bank feeds",
      capability: "Bank feed and statement reconciliation for business accounts",
      status: "unavailable",
      delivers: false,
      detail:
        "MaaCash is not a bank and holds no deposits. Branch cash and float are recorded here; no bank account feed is connected.",
      requiredApprovals: [
        "Bank or open-banking provider agreement",
        "Account-ownership verification and data-protection review",
        "Settlement and reconciliation ownership",
      ],
    },
    {
      id: "accounting",
      label: "Accounting export",
      capability: "Export or sync of financial records to external accounting software",
      status: "manual_process",
      delivers: false,
      detail:
        "Download reports as CSV for manual import into your accounting software. Automatic synchronisation is not available.",
      requiredApprovals: [
        "Target accounting platform and partnership agreement",
        "Chart-of-accounts mapping and idempotency design",
        "Reconciliation and correction ownership",
      ],
    },
    {
      id: "identity_verification",
      label: "Identity verification",
      capability: "Third-party verification of customer identity documents",
      status: "unavailable",
      delivers: false,
      detail:
        "Identity details are recorded by staff from documents presented in person; no external verification provider is contacted.",
      requiredApprovals: [
        "Identity provider contract and data-processing agreement",
        "Consent wording and retention limits for identity documents",
        "Error, appeal and manual-review process",
      ],
    },
    {
      id: "provider_payment_status",
      label: "Customer payment status",
      capability: "Independent confirmation of customer contributions and withdrawals",
      status: "unavailable",
      delivers: false,
      detail:
        "Paystack is used for MaaCash subscription billing only; it is not a source of truth for customer contributions.",
      requiredApprovals: [
        "Decision on whether customer payments are collected electronically",
        "Provider webhook, signature and replay-handling agreement",
        "Settlement and reconciliation ownership",
      ],
    },
  ];
}
