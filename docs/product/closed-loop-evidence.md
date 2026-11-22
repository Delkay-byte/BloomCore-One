# Closed-loop transaction evidence

**Status:** implemented as a provenance model plus a tenant-scoped read action, surfaced on
the anomaly desk.

Files:

- `src/lib/evidence-provenance.ts` — the ordered levels, explanations, timeline ordering.
- `src/lib/actions/evidence-provenance.actions.ts` — gathers the facts, tenant-scoped.
- `src/components/EvidenceProvenancePanel.tsx` — the panel.
- `tests/evidence-provenance.test.ts` — 14 tests.

---

## 1. The question this answers

An owner looking at a finding needs one thing before they act: *how do we know this?* A
figure can be typed by an employee, captured on a device, supported by a photo, matched to
an imported statement — and each of those is a different strength of claim. Collapsing them
into one green tick is how a business ends up trusting a number it should not.

## 2. The levels

Ordered weakest to strongest. A record's level is the strongest it reaches.

| Level | Meaning, in the owner's words | What produces it |
| --- | --- | --- |
| `agent_declared` | "Someone typed this into MaaCash." | The record exists in the tenant's books. |
| `device_captured` | "The record carries the device, the employee and the time it was written." | `recordedDeviceId` is set. |
| `evidence_attached` | "A file, a reference or a note was attached." | An `EvidenceAttachment` for the subject, or an operator's supporting-evidence pointer. |
| `statement_matched` | "This matched a row in a provider statement the business imported." | A `ProviderStatementRow` is matched to the transaction. |
| `provider_confirmed` | "An authenticated provider record confirms this transaction." | A fact that says a provider *record* exists. |

**Nothing in this build can produce `provider_confirmed`.** The action sets
`providerRecordConfirmed: false` and `providerIntegrationAvailable: false`, because no
approved, authenticated provider integration exists yet. An imported CSV, a typed reference,
a screenshot, an AI explanation and a statement match all stop one level short, deliberately.

## 3. Rules the model enforces

1. **A match is not a confirmation.** Every `statement_matched` result carries the note that
   an imported file is evidence the business kept, not a live confirmation from the network.
2. **No confirmation is stated by omission.** Every result below the top level carries "No
   network integration confirmed this transaction. MaaCash will not describe it as confirmed
   until one does."
3. **A correction is visible, not replaced.** A reversed or corrected record keeps its
   original entry and gains a note saying the original is kept and the correction carries its
   own author and time.
4. **An open case is not settled.** An open exception or anomaly adds "Nothing about it is
   settled yet."
5. **Next step, not a score.** Instead of a risk number, the result says what would
   strengthen the record: import the statement, or attach the counter evidence.
6. **Tenant-scoped, and silent about other businesses.** The action resolves through the
   caller's session and scopes every lookup to that tenant; another business's transaction
   returns "Transaction not found.", which discloses nothing.
7. **Undated events go last.** A timeline entry with no timestamp cannot be placed in the
   story, so it is appended rather than pretending it happened at the epoch.

## 4. Why it is a pure function

`deriveProvenance(facts)` takes facts and returns a conclusion. It cannot query, so it
cannot cross a tenant boundary by accident, and it can be tested exhaustively — which is the
point, because this is the module that decides what a business is allowed to claim about its
own records.

## 5. What it is not

- **Not a fraud score.** There is no number to rank people by.
- **Not a provider integration.** The seam is named and left shut.
- **Not a replacement for reconciliation.** It describes the state reconciliation produced.
- **Not a guarantee of truth.** A well-evidenced record can still be wrong; the panel says
  what the record rests on, not that it is correct.
