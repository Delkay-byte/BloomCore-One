# Zeli — Privacy Minimisation and Provider Gateway

**Status:** Gateway implemented; delivery denied. External AI disabled.

## Default deny

`submitOutboundPayload` always denies while `EXTERNAL_AI_PHASE = "disabled"`.
Validation failure also denies. There is no browser or tenant path that can send
a payload.

## Allow-list (future use only)

The typed schema accepts only:

- purpose: `trend_explanation`, `operational_summary`, `anomaly_explanation`;
- reporting period: date-only start/end and granularity `day|week|month`;
- aggregates: allow-listed metric name, bounded numeric value, unit
  `GHS|count|percent`, optional direction;
- cohort size;
- approved category names.

No free-text field exists.

## Rejected by design

- names, phone numbers, emails, addresses;
- account numbers, customer/staff ids;
- payment/transaction references;
- precise location, raw transaction rows;
- exact event timestamps;
- uploaded documents, customer notes, free-text database fields;
- authentication, token or MFA data;
- conversation history containing personal information;
- any unexpected or unapproved property, including `tenantId` inside the payload.

Rejection is structural (strict typed schema), not regex-only. Regex/pattern
checks are an additional guard for identifier-like values and free text.

## Aggregation and re-identification

- Minimum cohort defaults to 5.
- The threshold is configurable upward only; values below 5 are clamped to 5.
- Small groups are suppressed and the decision is audited.
- Suppression is one safeguard, not proof of anonymisation or legal compliance.
- Combinations of branch, date, category and rare values can re-identify.
  Payload design must be reviewed for each future purpose.
- Pseudonymisation and hashing are not anonymisation.
- Tenant-specific financial data is not sent merely because direct identifiers
  were removed.

## Audit

`ZeliProviderGatewayEvent` stores:

- decision (`allowed` / `denied`);
- reason;
- provider label;
- policy version;
- allow-list category names;
- observation and suppressed-group counts.

It does not store payload values, prompts, customer records or free text.

## Tests

`tests/zeli-privacy-gateway.test.ts` proves:

- unknown top-level and nested fields are rejected;
- sensitive field names and identifier-like values are rejected;
- free text and exact timestamps are rejected;
- raw input strings and wrong types fail closed;
- cross-tenant fields are rejected;
- small groups are suppressed and the threshold cannot be lowered below 5;
- no `fetch` call occurs while disabled, even with provider/approval/key set;
- audit rows contain no payload values;
- the DeepSeek credential value is never exposed.

## DPIA update points

The existing DPIA/privacy documentation should add:

- processing purpose and lawful basis for any future provider;
- categories and volume of aggregate data;
- retention of gateway decisions;
- sub-processor and cross-border assessment;
- re-identification risk review;
- owner approval record and policy version.

Until then, the correct data flow is: **no outbound transfer**.
