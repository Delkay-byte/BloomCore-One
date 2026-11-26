# Legal-source discrepancies and unresolved instructions

Owner: BloomCore Technologies. Version: 2026.11-discrepancy-1. Purpose: record conflicting
language in the supplied legal package, lawyer opinion and owner records so no reader assumes a
consensus that does not exist. This note does not resolve legal questions.

## 1. Live disclosure: disabled vs enabled

| Source | Language | Effect |
| --- | --- | --- |
| approved package Post-Implementation Review and DPC Inspection Memo | Safeguards substantially implemented; live cross-business disclosures must remain disabled until the Section 7 conditions are complete; inspection protocol is the real app with live disclosures off | Would keep the module unavailable during inspection |
| Formal Ghana Law Opinion, execution instruments condition (4) | Live cross-business disclosures remain enabled for the DPC testing | Would require the module to be live |
| Same opinion, condition (6) | Disabled and walkthrough records purged post-inspection | Conflicts with condition (4) and with the no-deletion instruction |
| Owner instruction | The DPC representative orally instructed that live cross-business disclosure functionality must be enabled during the examination | Current operating instruction |

Resolution applied: the application's normal live disclosure path is enabled,
subject to every existing safeguard and threshold. The oral instruction is
recorded as an owner instruction, not as written DPC approval. No walkthrough
records were created and nothing will be purged. The owner and lawyer must
confirm the written position before the examination.

## 2. Instrument numbering and missing text

The lawyer opinion uses Instruments 1-4 (Joint Controller Agreement,
Participation Terms, Single-Tenant DPA, Employee Notice) plus a public addendum.
The Final Privacy Determinations package refers to Instruments A/B/C but does not
contain a separate Instrument C text. The implementation therefore uses the
lawyer's Instrument 3 for the employee notice and the lawyer's public addendum
for Instrument 4. This is a source gap, not an invented clause.

## 3. Statutory citations

Some supplied material cites "Act 896" for data protection. The correct Ghanaian
statute is the Data Protection Act, 2012 (Act 843). The implementation and
public documents use Act 843. Any remaining Act 896 reference in a source
document must be corrected before external use.

## 4. Company identity and signatory

- Registered name is BLOOMCORE TECHNOLOGIES; registration number BN428031125.
- "Limited", "Ltd", "incorporated", an invented company number, a CEO title, a
  proprietor name or an address must not be added.
- The TIN is held in company records and must not appear on the public Privacy
  Policy or any public addendum.
- The authorised signatory must come from the verified profile recorded at
  `/platform/risk-access` (or the `BLOOMCORE_AUTHORISED_SIGNATORY_NAME` and
  `_CAPACITY` fallback); it must not be inferred from a display name.

## 5. Registered office

The lawyer opinion contains an address (Hse # L7, Olive St., Akast Rd., Akatsi
Volta Region). It is not treated as confirmed merely because it appears in a
draft. The renderer uses it only when the owner has confirmed it in the
organisation profile (or set `BLOOMCORE_REGISTERED_ADDRESS`); otherwise it
describes the registered office by reference to the Registrar of Companies
record. The owner must confirm the address before execution.

## 6. Instrument 1 and 2 integration edits requiring lawyer review

- Instrument 1 describes BloomCore as "a business duly registered" rather than
  using a corporate form that has not been verified.
- Instrument 2 adds a parties preamble so the participating business and
  BloomCore are identified before the operative terms.

These are integration edits for readability and correct identity. They are
flagged for the lawyer; they are not presented as approved wording.

## 7. Retention and post-inspection purge

The owner/lawyer condition to purge walkthrough records conflicts with the
instruction to preserve all records and with the retention schedule. No purge
routine was added. Records are retained under the scoped retention rules and
legal holds. If a DPC protocol requires a specific export or deletion, the privacy lead
must document the lawful basis and scope before any action.

## 8. Inspection claim boundary

Nothing in this repository or the application asserts that the DPC has
approved, certified or registered the module. The public addendum expressly
says it does not assert that any registration, approval or certification has
been granted. No one may describe the module as "DPC approved".
