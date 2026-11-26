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
  /**
   * Show the "Coming soon" marker for this integration.
   *
   * WhatsApp is deliberately false: the owner is building that integration, so the
   * product must not label it as unavailable. Every other unbuilt external
   * integration carries the marker, and a delivered integration never does.
   */
  comingSoon: boolean;
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
      status: "sandbox",
      delivers: whatsappDelivers,
      comingSoon: false,
      detail: whatsappDelivers
        ? "Cloud API credentials are configured and delivery is enabled for allowlisted numbers only. Approved utility templates are required."
        : whatsapp.configured
          ? "Cloud API credentials are present, but delivery is disabled by policy. Receipts are queued and remain unsent; nothing leaves MaaCash."
          : "Not configured for this deployment. Messages are previewed, validated and queued; nothing is transmitted or charged. This integration is being set up by the owner, so it is not marked unavailable.",
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
      status: sms.delivers ? "sandbox" : "unavailable",
      delivers: sms.delivers,
      comingSoon: !sms.delivers,
      detail: smsConfig.provider
        ? `SMS_PROVIDER is set to "${smsConfig.provider}", but no reviewed adapter for that provider exists. The mock adapter never sends.`
        : "No SMS provider has been selected. Messages are queued and validated only; nothing is transmitted.",
      requiredApprovals: [
        "Selected SMS provider and sender ID",
        "Per-message pricing and delivery monitoring",
        "Consent, opt-out and retention rules",
      ],
    },
    {
      id: "mtn",
      label: "MTN operational integration",
      capability: "Independent MTN confirmation of MoMo float, statements and transactions",
      status: telco.delivers ? "sandbox" : "unavailable",
      delivers: telco.delivers,
      comingSoon: true,
      detail:
        "Not available. MTN transactions are recorded by staff and can be reconciled against an imported CSV statement; no MTN system is contacted and no MTN record is confirmed.",
      requiredApprovals: [
        "MTN or aggregator API agreement",
        "Statement format, reconciliation and dispute process",
        "Data-protection review for customer transaction data",
      ],
    },
    {
      id: "telecel",
      label: "Telecel operational integration",
      capability: "Independent Telecel confirmation of float, statements and transactions",
      status: telco.delivers ? "sandbox" : "unavailable",
      delivers: telco.delivers,
      comingSoon: true,
      detail:
        "Not available. Telecel activity is recorded by staff and can be reconciled against an imported CSV statement; no Telecel system is contacted.",
      requiredApprovals: [
        "Telecel or aggregator API agreement",
        "Statement format, reconciliation and dispute process",
        "Data-protection review for customer transaction data",
      ],
    },
    {
      id: "at_money",
      label: "AT Money operational integration",
      capability: "Independent AT Money confirmation of float, statements and transactions",
      status: telco.delivers ? "sandbox" : "unavailable",
      delivers: telco.delivers,
      comingSoon: true,
      detail:
        "Not available. AT Money activity is recorded by staff and can be reconciled against an imported CSV statement; no AT Money system is contacted.",
      requiredApprovals: [
        "AT or aggregator API agreement",
        "Statement format, reconciliation and dispute process",
        "Data-protection review for customer transaction data",
      ],
    },
    {
      id: "banking",
      label: "Banking integration",
      capability: "Bank feed and statement reconciliation for business accounts",
      status: "unavailable",
      delivers: false,
      comingSoon: true,
      detail:
        "Not available. MaaCash is not a bank and holds no deposits. Branch cash and float are recorded in this product; no bank account feed is connected.",
      requiredApprovals: [
        "Bank or open-banking provider agreement",
        "Account-ownership verification and data-protection review",
        "Settlement and reconciliation ownership",
      ],
    },
    {
      id: "accounting",
      label: "Accounting integration",
      capability: "Export or sync of financial records to external accounting software",
      status: "unavailable",
      delivers: false,
      comingSoon: true,
      detail:
        "Not available. Reports and CSV exports can be downloaded and imported manually; no accounting system is written to from MaaCash.",
      requiredApprovals: [
        "Target accounting platform and partnership agreement",
        "Chart-of-accounts mapping and idempotency design",
        "Reconciliation and correction ownership",
      ],
    },
    {
      id: "identity_verification",
      label: "External customer identity verification",
      capability: "Third-party verification of customer identity documents",
      status: "unavailable",
      delivers: false,
      comingSoon: true,
      detail:
        "Not available. Customer identity is recorded by staff from documents presented in person; no external verification provider is contacted and no check is asserted.",
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
      comingSoon: true,
      detail:
        "Not available. Paystack is used for MaaCash subscription billing only; it is not a source of truth for customer contributions.",
      requiredApprovals: [
        "Decision on whether customer payments are collected electronically",
        "Provider webhook, signature and replay-handling agreement",
        "Settlement and reconciliation ownership",
      ],
    },
  ];
}
