# MaaCash Business-Owner Dashboard — Route-by-Route UI Audit

**Date:** 2026-11-28
**Reference:** the owner's three live screenshots of the Integrations page (taken 2026-11-28 10:14–10:16).
**Method:** every business-owner sidebar route was opened in the running
application at 390 px (mobile), 768 px (tablet), 1280 px (desktop) and 1440 px
(wide). Each route was measured for horizontal overflow
(`scrollWidth − clientWidth`, plus per-element inspection), checked for the
correct page content, and key pages were additionally reviewed visually with
screenshots. Defects were fixed at the shared level first, then per page.

---

## 1. Shared layout findings and fixes

| Finding (owner screenshots) | Root cause | Fix |
|---|---|---|
| Nested scrollbar appearance in the sidebar next to the page scrollbar | The 45-item navigation always scrolls inside the fixed sidebar, and its default browser scrollbar is as prominent as the document's | The navigation scroll area is styled as part of the dark surface (thin, brand-toned thumb, transparent track) with `min-height: 0` so it is the sidebar's only scrolling region; menu items get scroll margins so the active item never clips its neighbour. Brand area and Sign Out stay pinned. |
| Cards too narrow; 5–8 line paragraphs | The capability grid forced three columns at the owner's 1280 px viewport (~265 px cards) | Two-column grid at tablet/desktop, three only on very wide screens; per-card explanations shortened to one or two owner-facing sentences. |
| Status legend crowded, uneven | Seven statuses in three columns with wildly different text heights | Two-column legend with one-line meanings. |
| Repeated disclaimers under every provider | "Does not deliver outside MaaCash" ×10 and an approvals expander ×10 | Delivery fact consolidated into one sentence under the operator-recorded section; enablement requirements collapsed into a single page-level section. |
| Weak hierarchy / poor space use | Per-page grid choices | Addressed per page below; shared content container unchanged (`max-w-7xl`). |

## 2. Route audit results

| Route (menu) | 390 px | 768 px | 1280 px | 1440 px | Notes |
|---|---|---|---|---|---|
| `/admin/dashboard` (Dashboard) | 0 | 0 | 0 | 0 | Retry banner verified visually |
| `/zeli` (Zeli Assistant) | 0 | 0 | 0 | 0 | |
| `/admin/zeli-analytics` (Zeli BI) | 0 | 0 | 0 | 0 | |
| `/admin/locations` (Locations) | 0 | 0 | 0 | 0 | |
| `/admin/workers` (Workers) | 0 | 0 | 0 | 0 | |
| `/admin/ledger` (Transaction Ledger) | 0 | 0 | 0 | 0 | |
| `/admin/transfers` (Cash & Float) | 0 | 0 | 0 | 0 | |
| `/admin/liquidity` (Branch Liquidity) | 0 | 0 | 0 | 0 | Screenshots at 390/1440: clean |
| `/admin/reconciliation` (Reconciliation) | 0 | 0 | 0 | 0 | |
| `/admin/shifts` (Shifts & Handovers) | 0 | 0 | 0 | 0 | |
| `/admin/performance` (Performance) | 0 | 0 | 0 | 0 | |
| `/admin/anomalies` (Anomaly Monitor) | 0 | 0 | 0 | 0 | |
| `/admin/risk-intelligence` (Shared Risk Intelligence) | 0 | 0 | 0 | 0 | |
| `/admin/privacy-review` (Privacy Review) | 0 | 0 | 0 | 0 | |
| `/admin/agreements` (Business Agreements) | 0 | 0 | 0 | 0 | |
| `/admin/history` (Money & History) | **641 → 0** | 0 | 0 | 0 | DEFECT FOUND & FIXED (§3) |
| `/admin/reports` (Reports) | 0 | 0 | 0 | 0 | |
| `/admin/reports/consolidated` (Consolidated Report) | 0 | 0 | 0 | 0 | |
| `/susu/admin` (Susu Overview) | 0 | 0 | 0 | 0 | |
| `/susu/admin/customers` (Customers) | 0 | 0 | 0 | 0 | |
| `/susu/admin/onboarding` (Register Customer) | 0 | 0 | 0 | 0 | |
| `/susu/admin/imports` (Customer Import) | 0 | 0 | 0 | 0 | |
| `/susu/admin/collectors` (Collectors) | 0 | 0 | 0 | 0 | |
| `/susu/admin/contributions` (Contributions) | 0 | 0 | 0 | 0 | |
| `/susu/admin/withdrawals` (Withdrawals) | 0 | 0 | 0 | 0 | |
| `/susu/admin/withdrawal-requests` (Withdrawal Requests) | 0 | 0 | 0 | 0 | |
| `/susu/admin/withdrawal-controls` (Withdrawal Controls) | 0 | 0 | 0 | 0 | |
| `/susu/admin/remittances` (Money Handed In) | 0 | 0 | 0 | 0 | |
| `/susu/admin/reconciliation` (Reconciliation) | 0 | 0 | 0 | 0 | |
| `/susu/admin/reconciliation/daily-closing` (Daily Closing) | 0 | 0 | 0 | 0 | |
| `/susu/admin/approvals` (Approvals) | 0 | 0 | 0 | 0 | |
| `/susu/admin/offline-requests` (Offline Requests) | 0 | 0 | 0 | 0 | |
| `/susu/admin/disputes` (Disputes) | 0 | 0 | 0 | 0 | |
| `/susu/admin/history` (Money & History) | 0 | 0 | 0 | 0 | |
| `/susu/admin/reports/overview` (Reports & Analytics) | 0 | 0 | 0 | 0 | |
| `/susu/admin/staff` (Staff & Access) | 0 | 0 | 0 | 0 | |
| `/susu/admin/guide` (Operational Guide) | 0 | 0 | 0 | 0 | |
| `/susu/support` (Support) | 0 | 0 | 0 | 0 | |
| `/admin/association` (Membership & Training) | **319 → 0** | 0 | 0 | 0 | DEFECT FOUND & FIXED (§3) |
| `/admin/billing` (Billing & Plan) | 0 | 0 | 0 | 0 | |
| `/admin/staff` (Staff) | 0 | 0 | 0 | 0 | |
| `/admin/policy` (Operations Policy) | 0 | 0 | 0 | 0 | |
| `/admin/messaging` (Message Delivery) | 0 | 0 | 0 | 0 | |
| `/admin/audit` (Activity History) | 0 | 0 | 0 | 0 | |
| `/admin/integrations` (Integrations) | 0 | 0 | 0 | 0 | Redesigned; screenshots before/after |
| `/admin/settings` (Settings) | 0 | 0 | 0 | 0 | |

"0" = zero horizontal overflow at that width. The two defects are described below.

## 3. Defects found and fixed

### 3.1 `/admin/history` — the document scrolled 641 px into blank space (mobile)

The page renders a wide history table (1060 px min-content) inside the shared
`.table-container` scroll area. Although the container and its card both clip,
Chromium still propagated the table's scrollable overflow to the **root**, so
the whole document could scroll sideways into empty background — the worst
version of a wide-table defect, because the user sees a working page and can
then swipe into nothing. Reproduced with `window.scrollTo(600, 0)`.

**Fix (shared):** `.table-container { contain: paint }` in `globals.css`.
Paint containment keeps a wide table's scrollable overflow inside its own
scroll area. This is the container every data table in the product uses, so
the fix applies to every page with a wide table, not just this route.
Verified: `scrollWidth 375`, `window.scrollX` stays 0 at 390 px; 768/1280/1440
unchanged; the table still scrolls horizontally inside its own container.

### 3.2 `/admin/association` — 319 px horizontal overflow (mobile)

The sponsorship panel's header used a no-wrap inline flex row
(`display:flex; justify-content:space-between`) with a wide title and a
right-aligned stats block, forcing the document past the viewport; the same
Chromium overflow propagation then carried it to the root.

**Fix:** the header wraps (`flexWrap: wrap`, items get `min-width: 0` and a
240 px flex basis), and the panel section is paint-contained (same mechanism
as §3.1). Verified: 0 px overflow at 390/768/1280/1440.

## 4. Verification of the redesigned Integrations page

Compared against the owner's three screenshots at the same viewport:

| Owner finding | After redesign |
|---|---|
| Cards too narrow, text wrapping excessively | Two columns at the owner's viewport; details wrap ≤2 lines |
| Status legend crowded | Two-column legend, one-line meanings, badges aligned |
| Card alignment inconsistent | Uniform card structure: title + badge row, capability line, explanation |
| Repeated approval sections | One collapsed page-level section listing each capability's requirements |
| Repeated delivery disclaimers | One consolidated sentence ("None of the 9 capabilities … delivers anything outside MaaCash") |
| Provider names too technical | MTN Mobile Money, Telecel Cash, AT Money, Bank feeds, Accounting export, Identity verification |
| Poor space use / hierarchy | Compact notice, balanced legend, wider cards, single consolidated limitation section |

All provider truths are preserved (statuses, sandbox/not-configured
distinctions, operator-recorded limitations, Paystack boundary). The browser
spec `e2e/maacash-coming-soon.spec.ts` asserts the new layout on chromium and
mobile-chromium.
