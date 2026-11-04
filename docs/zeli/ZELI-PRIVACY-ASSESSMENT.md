# Zeli — Privacy Assessment

**Status:** draft for owner/legal review. **Not legally approved.**
The DPC form acknowledgement is not final regulatory clearance.

**Scope:** this document covers the aggregate insight-explanation path. It does
**not** approve transmitting a user's message. That separate activity is
assessed in `ZELI-CONVERSATIONAL-PRIVACY-DECISION-PACK.md`, which is also
unapproved.

## Processing purpose (proposed)

Explain an already-computed aggregate business trend to an authorized tenant
administrator. The provider does not calculate financial facts and does not
receive records needed to identify a person.

## Controller / processor

- BloomCore One/tenant business: controller for business records.
- BloomCore Technologies: platform operator/processor as contracted.
- DeepSeek: external sub-processor **only if** a future approved state is
  enabled and a DPA is signed.

## Categories potentially transmitted (approved aggregate-only state)

- purpose category;
- reporting granularity (day/week/month/quarter);
- metric name;
- direction;
- change band;
- cohort band;
- approved category names;
- schema version.

No exact amount, date, name, identifier, raw row or conversation.

## Categories excluded

Names, phone, email, address, customer/worker/account ids, payment/transaction
references, precise location, exact timestamps, notes, documents, authentication,
MFA, conversation history, tenant id and user id.

## Cross-border processing

DeepSeek infrastructure location and retention must be confirmed contractually
before approval. No transfer is authorised by this document.

## Re-identification

A five-observation threshold is a safeguard, not anonymisation. Branch + period +
rare category combinations can identify. A purpose-specific re-identification
assessment is required before activation.

## Retention

- Local provider usage ledger: decision, category, latency and tokens only.
- No prompt/response content stored.
- Provider-side retention requires written confirmation.
- Conversation retention remains a separate owner decision.

## Data-subject requests

Local records can be located by tenant/user. Provider-side deletion depends on
the provider contract and must be documented before approval.

## Incident response

1. Emergency-disable external AI.
2. Preserve local audit records (no payload content).
3. Notify the owner/DPO and follow the incident procedure.
4. Contact the provider if a transfer is suspected.
5. Record remediation and notify regulators/data subjects where required.

## Matters requiring legal/DPC guidance

- lawful basis for external explanation;
- controller/processor roles and contract terms;
- cross-border transfer mechanism;
- retention and deletion confirmation;
- privacy notice wording and user authorization;
- whether tenant-level authorization is sufficient;
- re-identification risk for each purpose;
- children/vulnerable data (not expected, but confirm).

**Do not claim this architecture is legally approved.**
