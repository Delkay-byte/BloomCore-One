# Risk Intelligence retention and key rotation

## Retention schedule (implemented)

| Record | Rule | Code |
| --- | --- | --- |
| Active signal | 180 days from `observedTo` | `RISK_ACTIVE_SIGNAL_DAYS`, `expiresAt` |
| Expired signal | 90 days after expiry | `signalDeletionDeadline` |
| Withdrawn signal | 90 days after withdrawal | `signalDeletionDeadline` |
| Disputed signal | adjudication + 90 days after actual resolution | `signalDeletionDeadline`; open challenge returns no deadline |
| Notes and source pointers | parent signal lifecycle | scrubbing removes `internalNote`, `sourceId` |
| Disclosure / RI audit | 24 months | `riskAuditDeletionDeadline` |
| Executed agreement, authority and consent records | Relationship duration plus 6 years | Contractual record; not touched by the signal sweep |
| Employee notice and attestation | Life of the notice version plus the employment relationship; retain the version needed to prove what was issued | Historical notice text is never overwritten |
| Subject-rights case | Resolution plus 6 years, subject to a scoped legal hold | Case evidence is not scrubbed with signals |
| Security/access audit | Existing security retention schedule | Not shortened by the risk sweep |

Day-181 exclusion is evaluated in `evaluateRiskQuery` from `expiresAt`, so an
expired signal is excluded even if the sweep has not run. `expireStaleRiskSignals`
transitions open signals within the daily job; `runRiskRetentionSweep` performs
permanent scrubbing and deletion.

## Scrubbing

At the deletion deadline, `subjectKey` is replaced with a non-identifying
marker and `internalNote` / `sourceId` are removed. `deletedAt` and
`scrubbedAt` are recorded. Disclosure rows keep categories, bands, counts and
reason while `subjectKey` is scrubbed. No financial audit record is touched.

## Legal holds

`RiskLegalHold` is scoped to one identified signal, subject or request. It
stores hold reference, reason, authorising actor, creation date, review date,
case-closure date, extension and full release history. An active hold with no
authorised extension blocks deletion. Holds are reviewed within 14 days of case
closure; only specifically identified records connected to a proceeding, DPC
investigation or unresolved formal dispute may be held. The 14-day extension to
the 21-day resolution target is separate.

All periods are constants in `retention.ts` so a later DPC or lawyer recommendation
can change them in one place. The signal sweep must never delete a financial
record, an executed agreement, a notice attestation, a rights case or an active
legal hold. The 24-month disclosure de-identification is distinct from the
90-day signal scrub and from the 6-year contractual retention.

## HMAC secrets and rotation

- Secrets are separate from the application database. `secret-provider.ts`
  defines the production provider interface; the environment provider serves
  the existing local development workflow.
- No key, salt, hash input or hash output is logged. Access audit carries only
  version, provider id, operation, timestamp and outcome.
- Contributions use the active version. Queries try the active and every
  supported previous version (`candidateSubjectKeys`), so eligible signals stay
  matchable during rotation. A hash is never regenerated.
- `recordKeyRotation` and `retireKeyVersion` are privacy-admin only and record metadata.
  The active key cannot be retired.

`.env.risk-intelligence.local` remains local development only. Its salt must
not be printed, committed or reused in production. No production secret was
configured in this assignment.

Query matching now takes the supported version list from `RiskKeyVersion`
metadata, so retiring a version in the privacy lead workflow actually removes it from
candidate matching. Both new and previous versions must exist in the configured
provider before a rotation is recorded.

## PostgreSQL migration review

Static review found and fixed two blockers: the migration folder originally
sorted before `20261221_shared_risk_intelligence` (renamed to
`20261222_risk_intelligence_governance_safeguards`), and the schema column
`EmployeeNoticeAttestation.documentSha256` was absent from the SQL. Both
schemas validate with `prisma validate`. The migration has **not** been applied
or rehearsed on PostgreSQL; no database was provisioned or contacted. It remains
validated file, not verified deployment.
