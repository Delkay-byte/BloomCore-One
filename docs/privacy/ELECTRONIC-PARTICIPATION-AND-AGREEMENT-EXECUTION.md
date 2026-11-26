# Electronic participation and agreement execution

## Where it happens

Normal business onboarding and account management use the existing admin
workspace. Agreement metadata and stored text are written by
`src/lib/actions/risk-governance.actions.ts`; the business owner sees the
console in `RiskIntelligencePanel`. No separate DPC interface exists.

## Documents

The three documents come from the supplied supplied legal package. This module holds only
catalogue metadata:

1. Joint Controller Agreement.
2. Business Participation and Data-Sharing Terms.
3. Single-tenant Data Processing Addendum (where applicable).

Exact clauses are supplied by the source material. The code never invents
agreement text, and `version` and `effectiveDate` remain controlled until
confirmed. `AGREEMENT_CATALOGUE` records that status explicitly.

## Workflow

1. An authorised business representative opens the complete document.
2. The document is viewable and downloadable from stored text; its SHA-256 is computed.
3. Title, version and effective date are displayed.
4. Business legal identity is confirmed from the tenant record.
5. The signatory enters name, role and authority to sign.
6. Each document is accepted separately; a changed document hash is refused.
7. The lawyer-approved authentication method is recorded.
8. BloomCore countersigns where required, then the agreement becomes active.
9. Executed historical versions are preserved.

## Bound acceptance record

`ParticipationAgreement` stores document version, SHA-256, business id,
signatory id/name/role/authority, authentication method, timestamp and
countersignature. Each change is audited. States: draft, presented, accepted,
awaiting_countersignature, executed, active, superseded, terminated. Material
changes require a new version and fresh review/execution.

## Separate from employee notices

An employee privacy-notice acknowledgement is delivery evidence, not consent,
and does not waive statutory rights. It never substitutes for the business's
contractual acceptance or participation consent.

## Approval status

Execution evidence is stored on `ParticipationAgreement` (version, SHA-256,
business/signatory ids, authority declaration, authentication method and
verification evidence, accepted/countersigned/executed timestamps, state). A
new material version supersedes the earlier executed row instead of overwriting
it. Authorised users retrieve the exact text through
`getParticipationAgreementDocument` and `/admin/agreements`.

On countersignature, an `agreement_executed` email is queued through the
existing Resend provider to the signatory. `GovernanceDocumentDelivery` records
recipient reference hash, template version, provider message id, delivery
status and retry history. A failed or retried email never changes the execution
row or its audit history. An email receipt is not proof of legal execution.

Electronic execution is **not** claimed as legally approved. The authentication
method and applicable formalities require privacy-lawyer confirmation before
acceptance is opened in production. `RISK_AGREEMENT_HASHES` must contain the
approved SHA-256 for each type; presentation fails closed without it.
