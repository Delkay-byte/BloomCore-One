# Shared Agent Risk Intelligence — privacy and governance review

**Status:** local technical review, prepared for independent Ghanaian privacy/legal review.
**Feature state at the time of writing:** implemented, disabled by default, and *not enabled
in production*. Enabling it requires the owner decisions listed in §24.

> **Update, 25 November 2026.** The live cross-business disclosure path is now enabled and
> returns `insufficient_network` until the genuine 20-business / 3-contributor / 2-per-category
> gates are met. Several gaps recorded below have since been implemented: subject notice and
> acknowledgement, self-service rights intake and adjudication, cross-business subject freeze,
> legal holds, post-expiry deletion/scrubbing, dual-version key matching and rotation metadata,
> and an organisational profile. Where later sections say there is no subject-access route,
> no deletion routine or no dual-key rotation, treat that as the historical position that the
> current code supersedes. The current controls and residual gaps are recorded in
> `docs/PRIVACY_SECURITY_AND_DPO_DPS_AUDIT.md`; this review remains the record of the legal
> questions that still require independent advice.

This is an assessment, not a compliance statement. Nothing below should be read as "this
design is lawful because the tests pass". Several questions in §5 can only be answered by a
qualified adviser with knowledge of the operating jurisdiction, the employment context, and
the association's own rules.

Source of record:

| Concern | Path |
| --- | --- |
| Policy and rules | `src/lib/risk-intelligence/policy.ts` |
| Subject hashing | `src/lib/risk-intelligence/hasher.ts` |
| Server operations | `src/lib/actions/risk-intelligence.actions.ts` |
| Console | `src/components/RiskIntelligencePanel.tsx` |
| Schema | `prisma/schema.prisma` — `RiskIntelligenceConsent`, `AgentRiskSignal`, `RiskIntelligenceDisclosure` |
| Migration | `prisma/migrations/20261221_shared_risk_intelligence/` |
| Feature documentation | `docs/product/shared-agent-risk-intelligence.md` |
| Tests | `tests/risk-intelligence.test.ts` (21), `tests/risk-intelligence-acceptance.test.ts` (13) |

---

## 1. Purpose and intended users

**Purpose.** A cashier who takes money and moves to the next shop is a real pattern in this
market. The next employer has no way to know, and the previous employer has no lawful way to
warn them. The feature lets participating businesses contribute a narrow, factual *signal*
from a closed incident in their own records, and lets a business ask whether other
participating businesses have independently reported the same kind of problem about someone
it already employs or is about to employ.

**Intended users.** Business owners (role `admin`) of mobile-money and Susu businesses that
have themselves joined. There is no consumer-facing surface. There is no platform-staff
screen: every operation authorises through `requireTenantAdminMomo()`, so a MaaCash employee
using the product has no route to these records. (Direct database access by infrastructure
operators is a separate risk — §15, §19.)

**Intended benefit.** A prompt to check. Not a decision, not a rejection, not a list.

## 2. Data flow

```
  Subject (agent/employee)               Business A  (contributor, joined)
        │                                    │
        │ 1. employed, day closes short      │
        └───────────────────────────────────►│ 2. owner opens the anomaly/investigation record
                                             │ 3. contributes ONE signal about that closed record
                                             │    category, severity, dates, private note
                                             │    subject identified by name + phone
                                             ▼
                             ┌──────────────────────────────────────┐
                             │ 4. hash: HMAC-SHA256(salt, v1|name|ph)│
                             │    stored: subjectKey (64 hex)        │
                             │    not stored: name, phone            │
                             └───────────────┬──────────────────────┘
                                             │  AgentRiskSignal (tenantId = A)
                                             ▼
   Business B, C … (contributors) ──►  AgentRiskSignal rows (one per business per record)
                                             │
                                             │ 5. Business D (viewer, joined) asks about
                                             │    an employee it already has on file
                                             ▼
                             ┌──────────────────────────────────────┐
                             │ cohort = distinct OTHER businesses    │
                             │ needs ≥ 3, and ≥ 2 per category       │
                             │ bands, not counts; no identities      │
                             └───────────────┬──────────────────────┘
                                             │ 6. disclosure written in the same transaction
                                             ▼
                                  RiskIntelligenceDisclosure (D)
                                  + tenant audit row
                                             │
                                             ▼
                          "More than one business reported the same kind of
                           problem. Review your own records."
```

Reality check on the diagram: steps 4–6 all happen inside MaaCash. The platform is not a
neutral pipe at step 5 — it computes the cohort and decides what is disclosable. That
matters for the role analysis in §4.

## 3. Exact information collected, processed, stored and disclosed

### 3.1 Collected from the contributing business

| Field | Content | Storage |
| --- | --- | --- |
| Subject identity | employee's full name + phone number, as already held in the business's own staff list | **not stored**; used only to compute the key |
| `subjectKey` | `HMAC-SHA256(RISK_INTELLIGENCE_SALT, "v1|normalised-name|normalised-phone")`, 64 hex characters | stored |
| `keyBasis` | the literal `"name+phone"` — which fields went into the key | stored |
| `saltVersion` | `1` | stored |
| `category` | one of six enumerated categories (§3.3) | stored |
| `severity` | `high` / `medium` / `low` | stored |
| `observedFrom`, `observedTo` | the incident period | stored |
| `expiresAt` | `observedTo + 180 days` | stored |
| `sourceType`, `sourceId` | the business's own closed record (anomaly investigation, exception case, or daily account) | stored, never disclosed |
| `internalNote` | ≥ 10 characters the contributing business wrote for itself | stored, never disclosed |
| `tenantId` | the contributing business | stored, never disclosed to another business |

### 3.2 Stored about consent and disclosure

| Record | Content |
| --- | --- |
| `RiskIntelligenceConsent` | policy version accepted, scope (`share_signals` or `query_only`), who consented and when, who withdrew and when, withdrawal reason |
| `RiskIntelligenceDisclosure` | viewing business, `subjectKey`, the verdict, the *categories and bands* disclosed, contributor count, viewer, stated reason, timestamp |

The disclosure log deliberately does **not** record which businesses contributed. A leaked
disclosure log therefore cannot identify contributors.

### 3.3 The six categories

`shortage` · `repeated_shortage` · `unreconciled_day` · `evidence_gap` ·
`unconfirmed_handover` · `policy_breach`

Each is a factual description of an operational event ("a day ended short"), not a
characterisation of a person. There is no "theft", "fraud", "dishonest" or "blacklist"
category, and the enumerated list rejects anything else.

### 3.4 What is never collected

No national ID, no photograph, no address, no date of birth, no bank or MoMo number, no
customer data, no evidence files, no statement rows, no free-text narrative about the person
(the note is about the *incident* and is never disclosed), no device identifiers of the
subject, and no location of the subject.

### 3.5 What is disclosed to another business

Only: the category label, a severity band, a coarse contributor band ("3 to 5 businesses"),
and the month-level "most recent observation". Plus the standing statement that this is a
prompt to check and not a finding.

## 4. Roles of the parties

| Party | De facto role | Why |
| --- | --- | --- |
| The contributing business | Controller of its own report | It decides whether to join, which of its own records to report, and may withdraw |
| The viewing business | Controller of its own query and of what it does with the answer | It chooses the subject and the purpose |
| MaaCash | Processor for each business's own operations; **functionally a joint controller or a shared-register operator** for the cross-business matching and disclosure | It decides the cohort rule, the bands, what may be disclosed and to whom, and it holds the salt |
| The subject (agent) | Data subject | Their identity is pseudonymised in the register but derivable by the platform |

The joint-controller question is the single most consequential legal question here. If
MaaCash merely hosted each business's data, a processor agreement per business would be
enough. Because MaaCash *decides* that three reports combine into a disclosure to a fourth
party, that determination is a controller-level decision. Counsel should decide between:

- (a) a joint-controller arrangement with a published allocation of responsibilities, or
- (b) an independent "shared register" operated by MaaCash under its own lawful basis, with
  each business contributing under a separate lawful basis of its own.

The design supports either, but the documentation, the privacy notice and the contracts
differ, and a processor-only framing would be inaccurate.

## 5. Purpose and legal-basis questions requiring independent review

These are questions, not conclusions. They are framed against Ghana's Data Protection Act,
2012 (Act 843) because that is the operating jurisdiction, and cross-referenced to GDPR
concepts where they are analytically useful. Nothing here has been verified by counsel.

1. **Is there a lawful basis at all for processing a person's data for the purpose of
   warning *other* employers?** This is a purpose the subject did not initiate and cannot
   refuse. Candidates are the legitimate-interest of the businesses (with a balancing test),
   or consent — and consent from an employee to a system that records their alleged
   shortcomings is unlikely to be freely given in an employment relationship.
2. **Act 843 purpose specification and compatibility.** The data was collected for
   employment and cash-accountability purposes. Is sharing it with unrelated businesses a
   compatible secondary purpose? The answer likely turns on how narrowly the categories are
   drawn and whether the disclosure is proportionate.
3. **Data minimisation and proportionality.** Pseudonymisation, category limits, cohort
   thresholds, bands, and 180-day expiry are the mitigations. Is a *suspicion-sharing*
   register proportionate to the harm it addresses at all, when the alternative (check
   references, probation, tighter reconciliation) is less intrusive?
4. **Is an allegation of a cash shortage a "criminal record" or similar sensitive
   category?** Probably not on its face, but if a category implies the offence of stealing,
   a stricter regime may apply. Counsel should decide whether any of the six categories must
   be reworded or dropped.
5. **Transparency.** Act 843 requires that the subject be aware of the processing. The
   current design has **no subject-facing notice and no subject-access or correction route**.
   That is a substantive gap (§17, §18, §24) and it must be resolved before enablement, not
   after.
6. **Registration.** Does operating a shared register of this kind require registration or
   notification with the Data Protection Commission? Assume yes until advised otherwise.
7. **Cross-border processing.** If the deployment, backups or logs sit outside Ghana, a
   transfer basis is needed.
8. **Retention.** Is retaining withdrawn-or-expired signal rows (status changed, row kept
   for audit) compatible with the storage-limitation principle, and for how long?
9. **Employment-law overlay.** A signal about an employee may be "personal data" of a
   worker whose employer is a member of the association; the association's own rules on
   member conduct, discipline and data sharing may add obligations.
10. **Defamation exposure.** A business that reports in bad faith could expose itself, the
    platform, or the association. §23 assesses the reputation risk directly.
11. **Equalities / fair process.** A person may be refused work on the strength of a prompt
    they never see and cannot answer. Counsel should consider whether a right of reply is
    required as a condition of operating the register at all.

## 6. Consent and policy-version behaviour

- Joining is an explicit act by a business owner: `joinRiskIntelligence({ scope,
  acceptedPolicyVersion })`.
- The accepted version must equal `RISK_INTELLIGENCE_POLICY_VERSION`. A stale version is
  refused with "The shared risk policy has changed. Read the current version before
  joining."
- Two scopes exist: `share_signals` (contribute and query) and `query_only` (never
  contributes; a contribution attempt is refused).
- Consent is stored with the consenting user, the timestamp, the version and the scope.
  Withdrawal is a separate, audited act with a mandatory reason.
- **A policy change requires re-acceptance.** Bumping `RISK_INTELLIGENCE_POLICY_VERSION`
  makes every existing consent stale, which blocks queries and contributions until the owner
  accepts again. That is deliberate: the owner cannot be bound by terms they never saw.
- Consent here is *business* consent to participate, **not** the data subject's consent.
  Do not describe it to a regulator as the subject's consent.

## 7. The three-business qualification logic

Implemented in `evaluateRiskQuery` (`policy.ts`), in order:

1. tenant available → else `tenant_unavailable`
2. role is `admin` → else `role_not_permitted`
3. a consent row exists → else `consent_missing`
4. consent active and scoped → else `consent_withdrawn`
5. policy version current → else `policy_version_stale`
6. the subject exists in the caller's own business → else `subject_not_known_to_business`
7. a reason of ≥ 10 characters → else `reason_required`

Then the cohort rule:

- signals from the **caller's own business are excluded** from the cohort count;
- a signal must be unexpired and in an enumerated category to count;
- `distinct other businesses ≥ 3` (`RISK_INTELLIGENCE_MIN_CONTRIBUTORS`);
- a category is disclosed only if **≥ 2 distinct businesses** reported that category;
- severity is the highest reported, dates are the most recent observation;
- at most 12 category summaries.

**Consequence surfaced during acceptance:** because the caller's own report never counts,
the smallest network that can disclose anything is **three contributors plus one separate
viewer** — four participating businesses, not three. A contributor in a three-business
network sees nothing, even if all three reported the same thing. This is the safer
direction (harder to disclose, never easier), but it is a product expectation that must be
communicated honestly: an association pilot with four members can produce almost no
disclosures, and that is not a bug.

Tested by `tests/risk-intelligence-acceptance.test.ts` — "requires three distinct businesses
before disclosing anything".

## 8. Self-report exclusion

The cohort is built from `others` only:

```ts
const others = live.filter((signal) => signal.tenantId !== input.callerTenantId);
const contributors = new Set(others.map((signal) => signal.tenantId));
```

A business can therefore never unlock a disclosure with its own single report, and cannot
manufacture corroboration for itself. Its own signals are still returned to it in the
category summary only when the cohort rule is independently satisfied — it learns nothing it
did not already know from its own reports.

Tested: "never counts the caller's own signal towards unlocking disclosure"
(`tests/risk-intelligence.test.ts`) and the acceptance scenario above.

## 9. HMAC pseudonymisation design and key management

```
subjectKey = HMAC-SHA256( key = RISK_INTELLIGENCE_SALT,
                          message = "v1|" + normaliseName(name) + "|" + last9Digits(phone) )
normaliseName: lowercase, non-letters → space, collapse whitespace, trim
last9Digits : strip non-digits, keep the last 9 (drops +233 / 0)
```

- **Why HMAC and not a plain hash:** a plain SHA-256 of a phone number is trivially
  reversible by enumerating the (small) space of Ghanaian mobile numbers. The secret key is
  what prevents that.
- **Why both name and phone:** phone-only collides family phones; name-only collides
  strangers. Both are required, and the function throws when either is too short.
- **Salt requirements:** `riskSubjectSalt()` throws unless `RISK_INTELLIGENCE_SALT` is at
  least 24 characters. The acceptance secret was generated with `crypto.randomBytes(48)`
  (64 characters) and stored in `.env.risk-intelligence.local`, which Git ignores
  (`.gitignore:6:.env.*`). It was never printed, never committed, and **must not be reused
  in production**.
- **Rotation:** `saltVersion` is stored per row so a rotation is visible, but rotating the
  salt orphans every existing key (rows are retained; they stop matching). A rotation plan
  must therefore include either dual-key matching or a documented reset. Not implemented.
- **One salt for all businesses** (a shared key) is what makes cross-business matching
  possible. That means the salt is the single point of re-identification, and its custody is
  the highest-risk operational control in the feature.
- **No subject-facing salt exposure:** the hash is never shown to a business, and it is not
  returned by any action.

## 10. Are the data still personal data? Yes — treat as pseudonymous, not anonymous

The whole point of the register is that a business can ask "is this person known to others"
by supplying a name and phone number. So:

- Any party holding the salt, and the input, can compute the key and confirm a match by
  design. MaaCash holds the salt.
- Any party that *guesses* the key (a business that knows a name and phone and has the salt)
  can confirm. Businesses do not have the salt, so this is limited to platform custody.
- The `subjectKey` is stable across businesses and across time, so signals accumulate around
  one pseudonym over years (bounded by expiry per row).

Conclusion: the register is **pseudonymous personal data**, not anonymised data. Act 843 and
GDPR-style analysis both apply. Any design or policy document that describes it as
"anonymous" should be corrected.

## 11. Information bands and disclosure rules

| Disclosed | Not disclosed |
| --- | --- |
| Category label (one of six) | The contributing businesses |
| Severity band (highest reported) | The exact number of contributors |
| Contributor band: "3 to 5" / "6 to 9" / "10 or more businesses" | The internal note |
| Month-level most recent observation | The source record (anomaly, exception case, daily account) |
| The standing disclaimer | The subject's identity, phone number, or `subjectKey` |
| | Raw counts of signals |

Bands replace exact counts so that in a small market a business cannot infer the
contributor set from a precise number. This is partial mitigation only — see §19 (small-
market inference) and §23.

## 12. Retention and the 180-day expiry

- `expiresAt = observedTo + RISK_INTELLIGENCE_DECAY_DAYS (180)`.
- Expired signals are excluded from every query by the policy layer, and
  `expireStaleRiskSignals()` flips their status to `expired`.
- **Nothing is deleted.** Expired, withdrawn and superseded rows are retained for audit.
  There is no retention ceiling on `AgentRiskSignal` or `RiskIntelligenceDisclosure`, and no
  deletion routine exists. That is a deliberate audit decision and an open privacy question
  (§5.8, §18, §24): storage limitation requires a maximum, and none is set.
- The 180-day behaviour is tested on a fake clock —
  `tests/risk-intelligence-acceptance.test.ts` — "enforces the 180-day expiry on a fake
  clock", which advances the system clock to 2027-06-01 rather than waiting.

## 13. Audit events and review history

Every state change writes a tenant audit row through `createAuditLogTx`, inside the same
transaction as the change:

| Action | Written when | Notable fields |
| --- | --- | --- |
| `risk_intelligence.joined` | owner joins or re-accepts | scope, policy version, `financialMutation: false` |
| `risk_intelligence.withdrawn` | owner leaves | reason |
| `risk_intelligence.signal_shared` | a signal is contributed | category, severity, source type/id, expiry |
| `risk_intelligence.signals_viewed` | a query is answered | verdict, contributor count, categories |
| `risk_intelligence.signal_withdrawn` | a contributed signal is withdrawn | reason |
| `risk_intelligence.signals_expired` | the sweep expires rows | count |

A separate `RiskIntelligenceDisclosure` row records what was disclosed to whom, with the
stated reason. The disclosure is written **before** the caller sees the answer, in the same
transaction as the read.

## 14. Cross-tenant access controls

- Every action resolves the caller through `requireTenantAdminMomo()` — no action accepts a
  tenant from the request.
- `querySharedRiskSignals` looks the subject up as
  `where: { id: userId, tenantId: ctx.tenantId }`. Another business's employee returns
  "Employee not found." — indistinguishable from a nonexistent id.
- `contributeRiskSignal` verifies the referenced source record belongs to the caller's
  tenant for all three source types, and refuses otherwise.
- `withdrawMyRiskSignal` and `listMyRiskSignals` are scoped to `tenantId`.
- Reads of another business's `AgentRiskSignal` rows never expose `tenantId`, `internalNote`
  or `sourceId`; the query `select` does not even fetch them.

Tested: "refuses another business's transaction…" equivalents, plus
`tests/risk-intelligence-acceptance.test.ts` — "refuses to match a subject across businesses
that are not the caller's" and "refuses a contribution built on another business's record".

## 15. Access roles and permissions

| Role | Can do |
| --- | --- |
| Business owner (`admin`) | join, leave, contribute, query, list own signals, withdraw own signal |
| Worker / collector / customer | nothing — every action authorises as admin |
| MaaCash platform staff | **no product route**; no action authorises a platform session |
| Infrastructure operator with database or environment access | full read of `subjectKey`, `internalNote`, `sourceId`, and access to the salt → effectively re-identification |

The last row is the real access-control boundary and it is not enforced by the application.
A platform operator can read the notes and recompute hashes. Mitigations are organisational:
least-privilege database access, audited queries, and not storing the salt alongside the
database. This must be written into the operating procedures before enablement.

## 16. Encryption and storage protections

- In transit: the application is served over HTTPS; the disclosure path is a server action
  within the authenticated session.
- At rest: whatever the managed PostgreSQL provider offers. **There is no application-level
  encryption** of `internalNote`, `subjectKey` or the disclosure log, and no per-tenant key.
  A database dump therefore contains the register in readable form for notes, and in
  pseudonymous form for subjects.
- The salt lives in the environment, not in the database — which is the one separation that
  makes a database dump alone insufficient for re-identification.
- Backups inherit the same properties and the same retention questions.

## 17. Accuracy, false positives, and the correction gap

- **Accuracy controls:** a signal must point at a closed record of the contributing
  business; the note is mandatory; the incident period is recorded; the row expires.
- **False positives are expected.** A "shortage" may be a bank delay, a customer error, a
  mistyped figure, or a reconciliation artefact. The design mitigates by requiring
  independent corroboration from ≥ 2 categories-reporting businesses before anything is
  disclosed, and by phrasing the output as a prompt to check.
- **Correction gap (open):** the contributing business can withdraw its own signal, which is
  audited. The **subject** has no mechanism to contest a signal, no right of reply, no access
  request route, and no way to ask for correction. This is the most significant governance
  gap in the feature and is a condition of enablement (§24), not a nice-to-have.
- **Cross-business challenge (open):** if business D believes a signal about its own
  employee is wrong, it can only record its own view; it cannot flag another business's
  report. There is no adjudication path. Recommended before enablement: a challenge record
  with an association-level reviewer.

## 18. Withdrawal and correction handling

- **Business withdrawal:** `withdrawRiskIntelligence` sets the consent to `withdrawn` *and*
  marks all of that business's open signals `withdrawn`, in one transaction. Withdrawal is
  therefore effective immediately for everyone else's queries — tested by "stops sharing
  immediately when a contributing business withdraws" and by the acceptance scenario.
- **Single-signal withdrawal:** `withdrawMyRiskSignal` withdraws one contribution with a
  reason, without leaving the programme — tested by "lets a business correct its own report
  without leaving the programme".
- **Rejoin:** an existing consent row for the current policy version is reactivated rather
  than duplicated.
- **What withdrawal does not do:** it does not delete rows, and it does not undo disclosures
  already made. A business that has already been shown a band cannot be made to forget it.
  Both points must appear in any member-facing description.

## 19. Security threats and mitigations

| Threat | Mitigation in the design | Residual risk |
| --- | --- | --- |
| Platform insider re-identifies a subject | Salt kept out of the database; least-privilege operations expected | **High** — the salt holder can always recompute; organisational controls only |
| Business brute-forces the key space | Businesses never receive the salt or the key | Low |
| Business submits a false signal to damage someone | Must point at its own closed record; note required; audited; withdrawable; category enumerated | **Medium-High** — a determined bad actor with a real shortage can still report in bad faith; defamation risk is real |
| Business singulates a subject by combining bands across repeated queries | Bands, minimum cohort, 12-summary cap | **Medium** — repeated queries about the same person over time narrow the field; rate limit is 30 per 10 minutes per business, not a lifetime cap |
| Small-market inference (a business knows only three participants) | "3 to 5 businesses" band | **Medium-High** — in a four-member pilot, "3 to 5" is effectively "all of them". A publication rule (e.g. no disclosure until the network has ≥ 20 members) is recommended |
| Unauthorised read via IDOR | Every lookup tenant-scoped; foreign ids return "not found" | Low, tested |
| Leaked disclosure log identifies contributors | Log stores categories and bands, not contributors | Low |
| Leaked database identifies contributors | `tenantId` on signal rows **does** identify the contributor to anyone with DB access | Medium — DB access is the trust boundary |
| Subject data in application logs | Hashing happens in a server-only module; no action logs the name, phone or key | Low, verified by reading each action |
| Orphaned keys after salt rotation | `saltVersion` recorded | Medium — rotation plan not implemented |
| Silent false reassurance when the salt is missing | **Fixed during acceptance**: a query with an active consent and no salt now refuses with "not configured… do not read this as a clean report" instead of returning "no shared signals" | Low, tested |

## 20. Emergency disablement and incident response

Three levels, in increasing order of destructiveness. All are reversible except the last.

1. **Deployment-level (immediate, no data change):** unset `RISK_INTELLIGENCE_SALT` and
   restart. Joining is refused, hashing throws, and queries now return an explicit
   "not configured" refusal rather than an empty answer. Nothing is lost; restoring the salt
   restores the register exactly.
2. **Per-business (no data loss):** the owner withdraws, which stops that business's signals
   counting for others immediately, or sets `scope = query_only`.
3. **Data-level (operator, with the owner's authority):** `UPDATE "RiskIntelligenceConsent"
   SET status = 'withdrawn'` for all tenants, and/or `UPDATE "AgentRiskSignal" SET status =
   'withdrawn'`. Rows are retained; nothing is destroyed.

Incident response that is **not** yet written and must be before enablement: who to notify,
in what timeframe, how a subject complaint is triaged, how a suspected bad-faith report is
frozen (there is no "freeze" flag today — a signal is either open, withdrawn or expired), and
how disclosures already made are handled.

## 21. External recipients and third-party processing

- **No third-party processors** are used by this feature. No analytics, no AI provider, no
  messaging provider, no external hashing service. The hash is computed locally with
  `node:crypto`.
- **External recipients are other participating businesses** — which is the whole point, and
  the hardest part of the legal analysis. Once disclosed, a band about a person is in another
  business's hands and MaaCash cannot recall it.
- The register is not sold, exported, or made available to the association or the platform
  by any route.

## 22. Test evidence

| Property | Test file | Test name |
| --- | --- | --- |
| Ordered denials, all seven | `tests/risk-intelligence.test.ts` | "refuses every caller who has not joined, in the order they would meet it" |
| A single report is never disclosed | same | "never discloses a single business's report" |
| Three businesses, same category → disclosure | same | "discloses only once independent businesses agree on the kind of problem" |
| Categories never merge | same | "will not combine unrelated complaints into one accusation" |
| Own signal never counts | same | "never counts the caller's own signal towards unlocking disclosure" |
| Expired and unknown categories ignored | same | "ignores expired signals and unknown categories" |
| Not a blacklist | same | "is structurally not a blacklist" |
| Published promises | same | "tells every joiner what it promises" |
| Contribution rules | same | `describe("validateRiskContribution")` — 3 tests |
| HMAC behaviour, salt required | same | `describe("hasher")` — 3 tests |
| Consent, cohort, disclosure audit, withdrawal, cross-tenant, hash-only storage | same | `describe("shared risk intelligence in the database")` — 9 tests |
| End-to-end three-business scenario, 180-day expiry on a fake clock, salt removal | `tests/risk-intelligence-acceptance.test.ts` | 13 tests, including "refuses to answer rather than saying nobody reported, when the secret is removed" |
| PIN/OTP never captured | `tests/counter-companion.test.ts` | "never stores a PIN typed into the reference" |

Runs at the recorded tree: **34 tests pass** across the two risk-intelligence files; the
full gate reports 153 files / 1780 tests passing.

## 23. Remaining risks, including unfair reputational harm

**The central risk, stated plainly.** A person can be refused work because two or three
businesses recorded that a day ended short, without ever seeing the report, without a chance
to explain, and without knowing the report exists. The mitigations (own-record requirement,
category limits, cohort thresholds, bands, expiry, "prompt to check" wording, no automated
decision) reduce but do not eliminate that harm. Two things make it worse than it looks:

1. **Corroboration is not truth.** Three businesses can be wrong in the same direction — for
   example, if they all use the same misconfigured reconciliation, or all mis-handle the same
   network's settlement delay.
2. **Bands in a small market are close to identities.** In a four-member pilot, "3 to 5
   businesses" may be the whole association, so the contributor set is inferable even though
   it is not disclosed.

**Assessment:** the feature does **not** operate as a blacklist, does not reveal identities in
its output, and does not automatically declare guilt. Its output is a review prompt with
explicit disclaimers, and the code contains no rejection, blocking or flagging capability.
That is a genuine and verifiable property, not a marketing claim — but it is a *procedural*
safeguard, not a *substantive* one: a business can still act on a prompt however it likes.

**Residual risks to carry into the legal review:**

1. No subject notice, access or correction route (highest priority).
2. No subject challenge or right of reply.
3. No adjudication path for a challenged report.
4. Small-market inference; no minimum-network-size publication rule.
5. No retention ceiling; expired and withdrawn rows retained indefinitely.
6. Salt custody is the re-identification boundary and is protected only organisationally.
7. No salt-rotation plan.
8. Joint-controller versus shared-register role unresolved; privacy notice and contracts
   depend on it.
9. No incident-response runbook for the register.
10. A bad-faith report remains possible and carries defamation exposure for the reporter, the
    association, and possibly the platform.

## 24. Legal and privacy lead decisions required before production enablement

Do not enable the feature in production until each of these is decided and recorded:

1. **Lawful basis** for processing, per role, for (a) a business contributing, (b)
   MaaCash matching and disclosing, and (c) a business acting on a disclosure.
2. **Controller configuration** — joint controllers, or independent shared register with a
   published allocation of responsibilities.
3. **Subject transparency package** — what the subject is told, when (at hire? on
   contribution?), and by whom (the employer as controller, or the platform).
4. **Subject rights procedure** — access, correction, objection, and complaint handling, with
   named responsibility and timeframes.
5. **Right of reply / challenge procedure**, including who adjudicates and how a signal is
   frozen pending review.
6. **Retention policy with a maximum**, including a deletion schedule for expired and
   withdrawn rows and for disclosure logs.
7. **Minimum network size for disclosure** (the small-market rule), set numerically and
   enforced in `policy.ts`.
8. **Salt custody, rotation and rotation-compatible matching**, plus least-privilege database
   access and query auditing.
9. **Data Protection Commission registration/notification**, if required, and any
   cross-border transfer basis.
10. **Association policy** — whether MoMAG/MMAAG endorses the register at all, which is an
    association decision separate from this engineering work.
11. **Defamation review** of the six category labels, the disclaimer wording, and the
    member-facing description of withdrawal (which cannot undo a disclosure already made).
12. **Incident-response runbook** for suspected bad-faith reporting, data breach, and a
    subject complaint.

Until items 1–5 are settled, the register should stay disabled. That is not a technical
limitation: the code works, and the tests above show it. It is a governance decision that
belongs with the owner and their adviser, not with the software.
