# Skipped browser tests — review

Companion to [LOCAL-FINAL-ACCEPTANCE-REPORT.md](./LOCAL-FINAL-ACCEPTANCE-REPORT.md).

The browser acceptance run at the recorded tree reports **116 passed, 11 skipped, 0
failed**. This document names every skipped test, states the exact skip condition, and
classifies each one. No skip was removed and no test was weakened.

---

## 1. How the list was produced

```
node scripts/verify-e2e.mjs --workers=2
```

with the project's `list` reporter, which prints skipped tests as `-` lines. The eleven
skipped entries from that run, in full:

```
  -  5 [chromium] › e2e\custom-domain.spec.ts:16:7 › live canonical custom domain › serves canonical metadata and no Render host in public HTML
  -  6 [chromium] › e2e\custom-domain.spec.ts:28:7 › live canonical custom domain › sitemap and robots use the canonical origin
  -  7 [chromium] › e2e\custom-domain.spec.ts:40:7 › live canonical custom domain › manifest and service worker install on the custom origin
  -  8 [chromium] › e2e\custom-domain.spec.ts:79:7 › live canonical custom domain › health, readiness, routes and auth boundaries respond
  -  9 [chromium] › e2e\custom-domain.spec.ts:117:7 › live old-host transition › stays reachable without a blanket redirect and shows the notice
  - 10 [chromium] › e2e\custom-domain.spec.ts:129:7 › live old-host transition › keeps health and synchronization routes reachable
  - 28 [chromium] › e2e\maacash-evidence.spec.ts:32:9 › MaaCash visual evidence › landing and sign-in at 360px
  - 29 [chromium] › e2e\maacash-evidence.spec.ts:32:9 › MaaCash visual evidence › landing and sign-in at 390px
  - 30 [chromium] › e2e\maacash-evidence.spec.ts:32:9 › MaaCash visual evidence › landing and sign-in at 768px
  - 31 [chromium] › e2e\maacash-evidence.spec.ts:32:9 › MaaCash visual evidence › landing and sign-in at 1280px
  - 32 [chromium] › e2e\maacash-evidence.spec.ts:60:7 › MaaCash visual evidence › draft list, saving, saved and restored states at 1280px
```

There are only two skip sources in the whole suite:

| File | Line | Condition |
| --- | --- | --- |
| `e2e/custom-domain.spec.ts` | 14 | `test.skip(!CANONICAL, "Set MAACASH_CANONICAL_ORIGIN to verify production.")` — `CANONICAL = process.env.MAACASH_CANONICAL_ORIGIN` |
| `e2e/custom-domain.spec.ts` | 115 | `test.skip(!LEGACY, "Set MAACASH_LEGACY_ORIGIN to verify the transition host.")` — `LEGACY = process.env.MAACASH_LEGACY_ORIGIN` |
| `e2e/maacash-evidence.spec.ts` | 25 | `test.skip(!process.env.CAPTURE_EVIDENCE, "Set CAPTURE_EVIDENCE=1 to capture screenshots")` |

No `describe.skip`, no `test.fixme`, no conditional skip inside a test body, and no
annotation-based skip exists anywhere else in `e2e/`.

## 2. Per-test findings

### 2.1 `e2e/custom-domain.spec.ts` — six tests

| Test | Skip condition | Classification | Run locally? | Security or financial workflow? | Re-run? | Evidence still missing |
| --- | --- | --- | --- | --- | --- | --- |
| `live canonical custom domain › serves canonical metadata and no Render host in public HTML` | `MAACASH_CANONICAL_ORIGIN` unset | **Environmental + external** — asserts against a deployed origin over HTTPS | No: it would need a live deployment, and contacting production is prohibited in this programme | Indirect (public branding/SEO). Boundary assertions inside it are security-relevant | Not run | Post-deploy evidence: canonical tag, OG URL, absence of Render hostnames |
| `… › sitemap and robots use the canonical origin` | same | same | No | No | Not run | Post-deploy evidence |
| `… › manifest and service worker install on the custom origin` | same | same | No | Indirect (SW scope) | Not run | Post-deploy evidence |
| `… › health, readiness, routes and auth boundaries respond` | same | same | No | **Yes** — asserts unauthenticated boundaries on the live origin | Not run | Post-deploy evidence |
| `live old-host transition › stays reachable without a blanket redirect and shows the notice` | `MAACASH_LEGACY_ORIGIN` unset | **Environmental + external** | No | Indirect | Not run | Post-deploy evidence |
| `… › keeps health and synchronization routes reachable` | same | same | No | Indirect | Not run | Post-deploy evidence |

**Verdict:** genuine environmental skips. They are *not* unverified product capability —
every behaviour they check has a local counterpart that did run: canonical metadata is
asserted in `maacash-landing.spec.ts` and `security-headers.spec.ts` against the local
origin, and the health/readiness routes are exercised locally by `tab-session-failures`
and the gate's build. What cannot be verified locally is the *production hostname*, which
is precisely what the release operations next month will establish.

**Action:** run these six after the owner-authorised deployment, by setting
`MAACASH_CANONICAL_ORIGIN` and `MAACASH_LEGACY_ORIGIN` in the operator's shell. They are
read-only HTTP checks and create no data.

### 2.2 `e2e/maacash-evidence.spec.ts` — five tests

| Test | Skip condition | Classification | Run locally? | Security or financial workflow? | Re-run? | Evidence still missing |
| --- | --- | --- | --- | --- | --- | --- |
| `landing and sign-in at 360px` | `CAPTURE_EVIDENCE` unset | **Opt-in evidence capture** (also asserts overflow ≤ 1px) | **Yes — re-run and passed** | No | Yes | none |
| `landing and sign-in at 390px` | same | same | **Yes — passed** | No | Yes | none |
| `landing and sign-in at 768px` | same | same | **Yes — passed** | No | Yes | none |
| `landing and sign-in at 1280px` | same | same | **Yes — passed** | No | Yes | none |
| `draft list, saving, saved and restored states at 1280px` | same | **Opt-in evidence capture that also tests a financial workflow** (draft save, restore, offline failure state) | **Yes — failed first, fixed, then passed** | **Yes** — worker daily-account draft handling | Yes | none |

**Command used:** `CAPTURE_EVIDENCE=1 node scripts/verify-e2e.mjs e2e/maacash-evidence.spec.ts --workers=1 --project=chromium`

**First run:** 4 passed, 1 failed. The failure is the defect described in the main report
§4.1 — after `page.context().setOffline(true)` the page navigated to `/login` and the
typed values were lost.

**Root cause:** `OfflineSessionGuard` ran its fail-closed redirect on every `offline`
event, including a live page whose connection merely dropped, so an online-only worker was
thrown to the sign-in screen mid-entry.

**Fix:** `src/components/OfflineSessionGuard.tsx` now performs the fail-closed check once,
for the page as delivered, and only reconciles the tab session when connectivity returns.
The fail-closed case that matters (a page restored from the offline cache without a valid
prepared session) still redirects to the login/offline prompt.

**Second run:** **5 passed** in 36.6s.

This is the clearest justification for reviewing skips rather than counting them: a
financial workflow with real data-loss impact had been excluded from every green run.

## 3. Skips that remain, and why

Eleven skips remain in the standard run, all of them the three conditions above. Nothing
was removed to raise the pass count. The two files are opt-in by design:

- `custom-domain` is opt-in so the normal suite can never touch a production host.
- `maacash-evidence` is opt-in so a normal run does not overwrite the committed evidence
  images in `docs/reports/evidence/`.

Both opt-in decisions are correct controls, not gaps. The gap was that nobody had run the
evidence spec locally, and running it found a defect.

## 4. Remaining evidence still owed

| Item | Who | When |
| --- | --- | --- |
| The six `custom-domain` checks | Owner/operator, after deployment | Next month, after the owner-authorised release |
| Physical-device PWA steps | Owner, on a phone | See [COUNTER-COMPANION-ANDROID-ACCEPTANCE.md](./COUNTER-COMPANION-ANDROID-ACCEPTANCE.md) §6 |
| A decision on whether `maacash-evidence` should run in the release checklist | Owner | Before release operations |
