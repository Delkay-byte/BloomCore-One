# Controlled legal instruments — MaaCash Shared Agent Risk Intelligence

Document owner: BloomCore Technologies (privacy function). Version: 2026.11-legal-2. Source: MaaCash Formal Ghana
Law Opinion and Execution Instruments (25 November 2026), Part II, and the
Final Privacy Determinations and Execution Package. This is an engineering control
record, not a substitute for legal advice.

## 1. Party identity

| Field | Value | Use |
| --- | --- | --- |
| Registered name | BLOOMCORE TECHNOLOGIES | All instruments and the public addendum |
| Registration number | BN428031125 | All instruments and the public addendum |
| TIN | Held in company records; intentionally not rendered | Never on the public Privacy Policy |
| Registered office | Configured only from `BLOOMCORE_REGISTERED_ADDRESS`; otherwise described as the Registrar of Companies record | Never invent an address |
| Signatory | Saviour Amegayie, Proprietor (owner-confirmed; supplied through the environment, never inferred) | Never invent a name or title |

Use of "Limited", "Ltd" or "incorporated" is rejected by the instrument
renderer. The renderer also rejects unresolved placeholders and the TIN.

## 2. Instruments

| Instrument | Audience | Conditional | Key content |
| --- | --- | --- | --- |
| 1. Joint Controller Agreement | Business | No | Role allocation, lawful basis, rights, security, retention, liability, Act 772 execution block |
| 2. Business Participation and Data-Sharing Terms | Business | No | Eligibility, strict contribution standard, non-reliance, withdrawal/suspension/expulsion, electronic execution |
| 3. Single-Tenant Data Processing Addendum | Business | Yes, only where the business does not already have equivalent terms | Processor obligations, breach notice, retention/return, execution |
| 4. Employee and Agent Privacy Notice | Employee | No | Purpose, pseudonymisation, thresholds, rights, retention, acknowledgement (not consent) |
| Public addendum (Instrument 4 public form) | Public | No | Joint-controller scope, thresholds, rights, security, non-reliance, contact |

Instrument 3 is the Employee and Agent Privacy Notice. Instrument 4 is the
public Privacy Policy addendum; the numbering follows the lawyer opinion and
must not be confused with the supplied legal package, which omits a separate Instrument C.
See `LEGAL-SOURCE-DISCREPANCIES.md`.

## 3. Dynamic population

Only verified facts are inserted: registered business name, registration
number, principal place of business, business email/phone, employee full name
and phone suffix, BloomCore registration/office/contact, signatory name and
capacity, authority basis and authentication method, document version and
effective date. Values come from the tenant record, the authenticated user and
the environment; they are never free text typed into a document body.

The employee notice is stored as the controlled template. Each employee sees a
copy populated with their own verified facts, and the SHA-256 recorded in
`EmployeeNoticeAttestation` is the hash of that exact populated text. If the
business profile or employee record is incomplete, the notice fails closed
rather than showing a placeholder.

## 4. Execution

1. The owner completes the business legal profile (legal name, registration
   number, address, email, phone, DPC registration status/number if held).
2. The owner selects capacity and authority basis and presents the instrument.
   The server renders it; the client cannot supply the text.
3. The owner re-enters the account password. The signatory name must equal the
   authenticated user's full name. The accepted document hash must match the
   presented text.
4. BloomCore's authorised signatory countersigns as BLOOMCORE TECHNOLOGIES. A platform
   owner can do this directly, or a tenant privacy lead with a valid grant;
   no DPO/DPS account is involved. Execution fails closed unless both the signatory and
   the owner-confirmed registered office are configured.
5. The state becomes executed only after countersignature. An execution
   certificate records the signatory, capacity, authority, authentication
   method, timestamps and SHA-256.
6. Both parties can retrieve the exact accepted text and hash from
   `/admin/agreements`. A delivery email is evidence of a receipt attempt, not
   of execution.

## 5. Version and approval control

`LEGAL_INSTRUMENT_VERSION = 2026.11-legal-2` and effective date `2026-11-25`
identify the controlled text. Approval is tied to that version, not to a
single deployment-wide final-document hash: each business has different party
facts, so a static final hash cannot be correct for every execution. The
per-agreement SHA-256 is retained as evidence of the exact document presented
and accepted.

The legacy `RISK_AGREEMENT_HASHES` path remains only for the legacy
`presentParticipationAgreement` flow used by existing tests and historical
records. It is not used by the controlled owner flow and must not be presented
as the approval mechanism for Instruments 1-4.

## 6. Electronic signature position

The instruments rely on Act 772 ss. 5, 7, 8, 10-12 and 23: authenticated
electronic acceptance, a reliable method, consent to electronic form, and
retention of an integrity-protected copy. Password re-authentication plus an
explicit acceptance act is the current method. The lawyer must confirm that
this method satisfies the formalities for each instrument and that no
wet-ink or witness requirement applies.

## 7. Employee notice and acknowledgement

Notice delivery must be evidenced before contribution. Acknowledgement is not
consent and does not waive rights. Accepted delivery methods are portal
acknowledgement, signed copy, witnessed verbal delivery, email and SMS, each
with a recorded reference. A failed or returned delivery remains unverified and
does not satisfy the contribution gate.

## 8. Open legal items

- Lawyer confirmation of the registered-name description in Instrument 1 and the added parties preamble in Instrument 2.
- Lawyer confirmation of the electronic-authentication method and the employee-notice acknowledgement wording.
- Owner or privacy lead confirmation that the public addendum matches the final approved Instrument 4.
- Owner has supplied the authorised signatory and capacity. The exact registered office is still not present in the repository or local environment; controlled execution is blocked until `BLOOMCORE_REGISTERED_ADDRESS` is set from the owner's confirmed record. The hosting schedule is also unset.
- DPC registration position; no registration number is asserted on any public page.
