# Zeli — Privacy Gateway

**Status:** implemented; delivery disabled unless an approved state permits it.

## Principle

The gateway accepts a typed `InsightPackage`. It never accepts a database record,
a conversation, a user prompt or arbitrary JSON. There is no “filter after
serialization” path.

## Explicitly permitted (future approved production)

- Purpose from a fixed enum.
- Reporting granularity: day, week, month, quarter.
- Comparison label: previous period or none.
- Metric name from a fixed enum.
- Direction: up, down, flat, unknown.
- Change band: <5%, 5–10%, 10–25%, 25–50%, >50%, unknown.
- Cohort band: 5–24, 25–99, 100+.
- Approved category names.
- Schema version.

No exact currency value is sent. Local code inserts exact values into the final
answer.

## Explicitly prohibited

- Names, phone numbers, emails, addresses.
- Customer, worker, staff, account, transaction or payment references.
- Raw rows, notes, documents, uploaded files.
- Authentication, session, token or MFA data.
- Conversation history and raw user text.
- Precise location and exact event timestamps.
- Tenant id, user id or any unexpected property.
- Unapproved purpose, metric or category.
- URL, email, long opaque identifier or free text.

## Small-group protection

- Minimum cohort is five by default.
- Environment configuration may raise it; values below five are clamped.
- The outbound package carries a band, not a count.
- The server checks the true cohort before allowing a request.
- Tests cover 1–4, exactly 5, rare categories, narrowed filters, synthetic
  mode, cross-tenant fields and unknown fields.

Five is a safeguard, **not** a claim of anonymization. Combinations of branch,
period, direction and rare categories can re-identify. Any future purpose needs
a privacy review.

## Prompt minimisation

The adapter receives a small system instruction plus the JSON package. It does
not receive:

- the user's question;
- prior messages;
- business name;
- customer or employee identity;
- balances;
- transaction history.

## Output validation

No model output becomes a financial fact. Numeric claims are rejected. Local
facts are inserted after validation. A rejected response falls back to the
private explanation.

## Audit

Recorded:

- request id;
- HMAC tenant/user reference;
- role category;
- provider/model;
- purpose and schema version;
- decision/rejection category;
- latency and token counts.

Not recorded:

- prompt or response content;
- API key;
- payload values;
- customer or employee data.

## Remaining legal work

- DPIA approval and lawful basis.
- Controller/processor and cross-border assessment.
- Retention and deletion confirmation with the provider.
- Privacy notice and user authorization wording.
- Re-identification review for each approved purpose.
