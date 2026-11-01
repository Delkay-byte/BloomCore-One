# Branch Review — BloomCore One rebrand and public site

**Reviewed range:** `fe876ed..1cf97d7` (branch `feature/bloomcore-one-brand-public-site`)
**Reviewer:** fresh-context reviewer subagent (cavecrew-reviewer), run after the
first commit. Findings were triaged and fixed in commit `7198642`.

---

## Verdict

16 findings: 1 question, 10 risks, 5 nits. No critical findings.
**15 addressed in code, 1 recorded as a deliberate ruling.** All fixes were
verified with the full suite and a production build after the fix pass.

---

## Findings and dispositions

| # | Where | Severity | Finding | Disposition |
| --- | --- | --- | --- | --- |
| 1 | `about:56` (+ footer, contact, privacy, terms) | ❓ question | Public pages asserted "registered sole-proprietorship business in Ghana" with no registration evidence in the repo | **Fixed.** The legal-form claim was removed everywhere. The site now says "a business based in Ghana". `docs` §5.1 records the rule: no legal form is published until the owner confirms it. Owner action added in docs §11.6 |
| 2 | `about:130` | 🟡 risk | Public `/about` printed the first tenant's name (BIK Prestige Enterprise) and workspace code `BIK-HQ-001`, contradicting the brand rule that the tenant appears only inside its workspace | **Fixed.** The card is now generic ("Each business, one workspace"); the tenant name and code no longer appear on any public page |
| 3 | `(marketing)/not-found.tsx:9` | 🟡 risk | The file could never render — Next.js routes every unmatched URL to the root `app/not-found.tsx`, so the docs claim was false | **Fixed.** Dead file deleted; root `not-found.tsx` rewritten as a neutral page (public-home and sign-in links, no workspace wording); docs corrected. See ruling R2 for the anonymous-visitor path |
| 4 | `(marketing)/page.tsx:149` | 🔵 nit | Hero tagline hardcoded while `PRODUCT_TAGLINE` sat unused | **Fixed.** Tagline is split from the single constant |
| 5 | `(marketing)/page.tsx:161` | 🟡 risk | Every "Request a Demonstration" CTA led to `/contact`, which has no submission route while `CONTACT_EMAIL` is unset | **Ruling R1 — kept.** The no-channel state is the sanctioned configuration: the site will not invent a channel or fake a submission. `/contact` states the gap plainly and lists exactly what the owner must supply; the CTAs become functional the moment `CONTACT_EMAIL`/`CONTACT_PHONE` is set |
| 6 | `(marketing)/page.tsx:165` | 🟡 risk | "Sign In" went to `/login` with no existing-session check, so a signed-in visitor had to re-pick a role — a regression from the old `/` redirect | **Fixed.** New `/workspace` entry point in the middleware: a signed-in visitor goes straight to the workspace their session covers, an anonymous visitor to `/login`. Landing and nav links plus the PWA `start_url` now use it. 5 new middleware tests cover it |
| 7 | `access/page.tsx:76` | 🔵 nit | Web Share title/text hardcoded the product name | **Fixed.** Uses `PRODUCT_NAME` |
| 8 | `globals.css:119` | 🟡 risk | Focus ring `brand-600` is 2.25:1 on the forest hero and 1.9:1 on the CTA band — below the 3:1 a focus indicator needs | **Fixed.** Dark surfaces use the light gold ring (`.focus-on-dark`, 8.2:1 on `brand-900`), applied to the marketing hero, CTA band, and both dark sidebars |
| 9 | `layout.tsx:32` | 🔵 nit | Open Graph alt hardcoded the tagline | **Fixed.** Uses `PRODUCT_TAGLINE` |
| 10 | `not-found.tsx:15` | 🟡 risk | "Go home" pointed at `/`, which is now the public marketing page, so a signed-in user lost their app home | **Fixed.** The 404 now offers "BloomCore One home" and "Sign in" |
| 11 | `select-workspace/page.tsx:102` | 🟡 risk | The brand link defaulted to `/`, leaving the workspace chooser mid-flow | **Fixed.** Points back to `/select-workspace` |
| 12 | `ConfirmSignOutButton.tsx:76` | 🟡 risk | Sign-out dialog still said "BIK Prestige" / "BIK Prestige Enterprise" | **Fixed.** Uses `PRODUCT_NAME` |
| 13 | `brand/Brand.tsx:115` | 🟡 risk | `sr-only` product name duplicated the visible wordmark, so screen readers heard the name twice | **Fixed.** The redundant span was removed |
| 14 | `MarketingFooter.tsx:28` | 🔵 nit | "BloomCore One" / "BloomCore One™" hardcoded | **Fixed.** Uses `PRODUCT_NAME` |
| 15 | `Sections.tsx:213` | 🔵 nit | CTA band defaults hardcoded both brand names | **Fixed.** Uses `PRODUCT_NAME` / `COMPANY_NAME` |
| 16 | `manifest.json:6` | 🟡 risk | `start_url` moved from `/` to `/login`, so an installed PWA opened a role picker for already-signed-in users | **Fixed.** `start_url` (and `id`) are now `/workspace`, which lands signed-in users in their workspace |

---

## Rulings recorded with the fixes

- **R1 — enquiry CTAs without a published channel.** Kept as-is. The brief
  forbids inventing a contact channel or faking a submission, so a
  demonstration request can only ever end at an honest statement until the
  owner sets `CONTACT_EMAIL` / `CONTACT_PHONE`. Cost if wrong: a visitor cannot
  convert until the owner supplies the channel — the same state the brief
  asked to be made visible rather than hidden.
- **R2 — anonymous visitor on an unknown URL is redirected to `/login`, not
  shown a 404.** This is the baseline middleware fallback ("unknown protected
  route requires at least some session") and it was kept deliberately: it is
  defence-in-depth that catches any future route added without a middleware
  rule. The neutral 404 renders for signed-in users. Cost if wrong: a public
  visitor who mistypes a marketing URL sees the branded sign-in page instead
  of a 404.

---

## Verification after the fix pass

- `npm test` → 14 files, **220 tests passed** (5 new `/workspace` tests).
- `npm run typecheck` → clean.
- `npm run lint` → 0 errors, 73 warnings.
- `npm run build` → compiled, 58 static pages.
- axe-core: **0 violations** on all seven public pages; heading order clean.
- Responsive: no horizontal overflow at 320–1920 px.
- Real login flows driven in headless Chrome against the production build —
  all six account types sign in and land on the correct dashboard; protected
  routes still 307; forged cookies still rejected; `/workspace` redirects
  correctly for anonymous visitors.
