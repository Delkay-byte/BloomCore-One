# Shared Agent Risk Intelligence — incident response runbook

Owner: BloomCore Technologies. Operational owner: security lead. Version: 2026.11-ir-1.
Applies to the Shared Register, its HMAC salt, executed agreements, employee
notices, subject-rights cases and governance notifications. It supplements the
general MaaCash incident plan; where the two differ, the stricter step applies.

## 1. Principles

- Preserve evidence. Do not delete logs, signals, agreements or database rows.
- Contain first, then investigate. A global disable or subject freeze is reversible.
- Inform the owner and security lead immediately; the owner decides statutory notification with legal advice.
- Do not speculate publicly and do not claim DPC approval or a confirmed breach
  before confirmation.
- Every action is recorded in `RiskControlEvent` and the audit log with actor,
  time, scope, reason and outcome.

## 2. Severity

| Level | Example | Initial response |
| --- | --- | --- |
| S1 critical | Salt or key exposure; cross-tenant disclosure; database compromise | Immediate containment; privacy lead and owner within 30 minutes |
| S2 high | Unauthorised privacy access; agreement or notice evidence tampering; repeated failed disclosures | Contain within 4 hours; privacy lead within 1 hour |
| S3 medium | Email delivery failure with metadata exposure; misconfigured threshold; disputed signal left unfrozen | Contain within 1 business day |
| S4 low | Isolated UI error, stale document version, failed retry | Normal support path |

## 3. Detection

Sources: `RiskControlEvent`, authentication and access audit, delivery retry
history, failed threshold checks, privacy review, business report, subject complaint,
provider notice, dependency advisory. Do not test with real personal data or by
creating synthetic businesses in the application database.

## 4. Containment

1. If disclosure integrity is at risk, set the global control to disabled with a
   written reason. This fails closed; it does not delete data.
2. If one business is the source, suspend its share consent and, where bad faith
   is suspected, escalate and expel under the participation terms.
3. If a subject is at risk, freeze the subject across all supported key versions
   and preserve the case reference.
4. If the salt is exposed, stop new submissions, retire the affected key version,
   activate a new version in the managed secret store, and preserve the old
   version only as long as needed to match lawful existing signals. Never print
   or paste the salt into a ticket, chat or document.
5. If a privacy access grant is compromised, revoke `RiskPrivacyAccess` and terminate the
   sessions through the existing session-revocation path.
6. If email is misconfigured, disable the outbound path rather than sending from
   an unverified domain; keep the durable delivery record and retry later.

## 5. Investigation

- Identify the data subjects, businesses, signals, agreements and notices affected.
- Establish the legal basis for each record and whether a legal hold applies.
- Preserve exact document hashes (`documentSha256`, `executionCertificateSha256`).
- Distinguish a confidentiality incident from a mere delivery failure; a failed
  email is not proof of unauthorised access.
- Record the timeline in the incident file; do not rewrite prior audit entries.

## 6. Notification

| Recipient | Trigger | Target |
| --- | --- | --- |
| Affected participating business | Any confirmed compromise affecting its data | Within 12 hours of confirmation (Joint Controller Agreement) |
| privacy lead / owner | Any S1 or S2 | Immediately, no later than 1 hour |
| Data Protection Commission | Confirmed personal-data breach requiring notification under Act 843 s. 31 | Internal operational target of 72 hours from confirmation; statutory assessment by the owner with legal advice |
| Affected individuals | Where the breach is likely to result in high risk to rights and freedoms | Without undue delay, in plain language, with mitigation advice |
| Email/hosting provider | Provider-side incident | Per contract and provider channel |

Notification content: what happened, when, what data and subjects, likely
consequences, containment, mitigation, contact point and next update. Do not
include another business's identities, notes or subject keys.

## 7. Recovery

- Re-enable global availability only after the owner or security lead confirms the cause is fixed.
- Verify thresholds, tenant isolation, agreement/notice gates and audit writes
  with the focused test suite before re-enabling.
- Reissue a notice or agreement only as a new version; never overwrite the
  executed text.
- Retry failed notifications idempotently; do not duplicate an execution event.

## 8. Post-incident

Within 5 business days: root cause, affected records, legal assessment, remedial
actions, owner and due date. Update this runbook and the RoPA if the processing
or sub-processors changed. Retain the incident file per the security schedule.

## 9. Contacts and evidence

The public privacy contact is `bloomcoretechnologies@gmail.com` (owner-confirmed).
That mailbox is the intake channel; it is not a DPO/DPS appointment and is not a
Resend sender identity. Operational roles are owner, security lead and privacy
contact. Personal escalation numbers and provider security contacts are held in
the security contact sheet, not in the repository.

## 10. Tabletop checks

- Salt exposure during rotation.
- Cross-tenant query due to a missing tenant filter.
- Agreement executed but countersignature missing.
- Employee notice published with an unresolved placeholder.
- Subject challenge received on a Friday before a Ghana public holiday.
- Email provider returns 429 for an execution receipt.
