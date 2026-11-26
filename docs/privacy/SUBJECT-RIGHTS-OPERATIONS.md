# Subject rights operations

## Where the workflow lives

- Workers and agents submit their own request from `/worker/privacy-notice`;
  the subject identity comes from the session, never from client input.
- Business owners may record a request received through another channel from
  the existing Risk Intelligence console
  (`src/components/RiskIntelligencePanel.tsx`).
- A delegated privacy lead and authorised privacy reviewers work in `/admin/privacy-review`. The
  page and every server action re-check an active `RiskPrivacyAccess` grant.
  A platform owner can operate the same restricted actions from the platform
  session. An ordinary administrator or support user cannot open the queue.

## Request types

`access`, `correction`, `objection`, `challenge`, `complaint_review`.
`objection`, `challenge` and `complaint_review` freeze the subject across every
supported HMAC key version for the whole adjudication.

## Service levels (enforced in code)

| Stage | Rule | Implementation |
| --- | --- | --- |
| Acknowledge | 3 business days | `computeRightsDeadlines` in `subject-rights.ts` (weekends and the versioned Ghana public-holiday calendar are excluded; the calendar version is stored on the case) |
| Resolve | 21 calendar days | same helper; stored as `resolutionDeadline` |
| Extension | one, up to 14 calendar days | `extendRightsDeadline`; refused if already extended or if the original deadline has passed; written reason stored |
| Freeze | entire adjudication | `RiskSubjectFreeze` + signal status `disputed_frozen` |
| Overdue | tracked | `listSubjectRightsRequests` computes the effective deadline and overdue flag |

## Case record

`SubjectRightsRequest` stores a secure random `SR-` reference, tenant, hashed
subject key, type, classification, reviewer, identity-verification state,
deadlines, extension reason, decision and decision reason. Communications are
append-only rows in `RightsRequestCommunication`. Supporting evidence is
stored as redacted metadata, never as another business's underlying report.

## Decisions

- **Upheld objection/challenge:** affected signals are withdrawn and the
  90-day post-resolution purge clock starts from the actual resolution date.
- **Rejected:** eligibility is restored only with a documented, reasoned
  decision, subject to the signal's original expiry.
- **Open:** the subject remains frozen; no disclosure can be given.

The receiving business is notified through the control-event and audit trail.
No underlying report from another business is shown to the employee or to the
receiving business.

## Financial records

Correction requests never rewrite historical financial evidence. Only the
signal/subject records and rights case are changed.

## Outbound notifications

When a subject is disputed, challenged or resolved, the contributing business's
active admin contacts receive one idempotent email through the existing Resend
path. The message carries a case reference and a link to a session-authenticated
MaaCash workflow. It contains no employee identity, subject key, source id or
another business's report. Delivery evidence is in `GovernanceDocumentDelivery`;
failure stays failed until an explicit retry succeeds. The audit event is
written whether or not delivery succeeds.

## Statutory context

Ghana's Data Protection Act, 2012 is **Act 843**. The authoritative Final Privacy
Determinations package confirms these provisions:

- legitimate interest basis: section 20(1)(e);
- objection and the duty to stop processing: sections 20(2) and 20(3);
- written notice to prevent processing, with a 21-day response: section 39;
- correction and access: sections 33 and 35;
- breach notification: section 31;
- registration: sections 46–56 (and section 27 for controller registration);
- assessable processing: section 57(1), subject to an Executive Instrument;
- cross-border sub-processor safeguards: sections 18(2), 28 and 30.

Supplied source documents cite "Act 896" and "sections 16/17–20/26/35" for
these matters. Those citations are inaccurate. Final legal characterisation
remains with the appointed privacy lawyer and DPC.
