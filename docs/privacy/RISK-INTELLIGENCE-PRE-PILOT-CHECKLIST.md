# Risk Intelligence pre-pilot checklist

Engineering work completed. Owner, DPC and professional decisions still open.
Do not treat a passing test as legal approval.

## Implemented and locally verified

- [x] ENG-01: 20-business eligible-network gate; cohort and category rules; explicit insufficient-network response.
- [x] ENG-02: subject/signal freeze across supported key versions; reasoned resolution paths.
- [x] ENG-03: rights submission, deadlines, reviewer, evidence, communications, restricted privacy queue.
- [x] ENG-04: retention schedule, day-181 exclusion, scrubbing, scoped legal holds.
- [x] ENG-05: secret-provider interface, dual-key matching, metadata-only audit, key retirement controls.
- [x] ENG-06: versioned notices, delivery evidence before contribution, disclosure explanation.
- [x] ENG-07: global / business / signal / subject emergency controls with full history.
- [x] ENG-08: electronic agreement execution, binding metadata and participation gates.
- [x] Additive schema and migration; no second database; existing records untouched.
- [x] Typecheck, lint (no errors), production build, full unit/integration suite.

## Infrastructure configuration required

- [ ] Register the managed production secret provider and durable audit sink.
- [ ] Set `RISK_RETENTION_TOKEN` and schedule POST
      `/api/internal/risk-intelligence/retention` daily under that token.
- [ ] Configure Resend with `RESEND_API_KEY` and `EMAIL_FROM_SECURITY`; keep
      `EMAIL_DELIVERY` enabled. Local test mode never calls the provider.
- [ ] Set `RISK_AGREEMENT_HASHES` to the approved SHA-256 for each agreement
      type. No agreement can be presented until this is set.
- [ ] Publish the approved employee privacy notice text and version.
- [ ] Grant and periodically review `RiskPrivacyAccess`.
- [ ] Apply the additive PostgreSQL migration in a deployment window after
      `20261221_shared_risk_intelligence`; it has not been applied here.

## Professional and DPC matters

- [ ] Lawful basis for contributing, matching/disclosing and acting on a prompt.
- [ ] Joint-controller allocation under Act 843.
- [ ] Lawyer confirmation of the electronic authentication method and formalities.
- [ ] Final notice wording and the five-line disclosure explanation.
- [ ] DPC registration/notification and any cross-border transfer basis.
- [ ] Association endorsement; defamation review of category labels.
- [ ] Incident-response runbook.
- [ ] Independent DPC examination of the real application after owner-authorised
      deployment. No synthetic review environment or prearranged scenario exists.

## Citation accuracy

Supplied documents cite "Act 896". The correct statute is the Data Protection
Act, 2012 (**Act 843**). The Final Privacy Determinations package confirms the
correct citations: section 20(1)(e), 20(2), 20(3) and 39 for lawful basis and
objection; sections 33 and 35 for correction and access; section 31 for breach
notice; sections 46–56 for registration; section 57(1) for assessable processing;
sections 18(2), 28 and 30 for cross-border safeguards. Section 16, 17–20, 26
and 35(3) in the older documents are wrong. Items not confirmed by that package
remain flagged for the appointed lawyer or DPC representative.
