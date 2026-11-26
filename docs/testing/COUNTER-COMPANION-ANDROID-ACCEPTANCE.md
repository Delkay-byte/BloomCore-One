# Counter Companion and Android acceptance

Companion to [LOCAL-FINAL-ACCEPTANCE-REPORT.md](./LOCAL-FINAL-ACCEPTANCE-REPORT.md).
This document records what can be verified on this machine, what cannot, and the exact
manual steps the owner must perform on a real phone. Nothing here is claimed as passed
without evidence.

---

## 1. What the product actually is

There is no Android application to build.

Verified by repository-wide search (excluding `node_modules` and `.next`):

| Artefact searched | Found |
| --- | --- |
| `AndroidManifest.xml` | none |
| `*.gradle`, `*.gradle.kts`, `Podfile` | none |
| `capacitor.config.json` / `.ts`, `expo.json` | none |
| `*.apk` | none |
| Android/Cordova/Capacitor/Expo/React Native/Electron/Tauri in `package.json` | none |
| `adb` on `PATH` | not installed |

MaaCash is a **Progressive Web App**:

- `public/manifest.json` — `display: standalone`, `start_url: /workspace`, three icons,
  and **no `permissions` key** (the web manifest has no such field; the point is that no
  permission is declared or requested anywhere).
- `public/tab-session-sw.js` — the only service worker.

Because there is no merged Android manifest, the "zero permission" claim is verified where
it is meaningful for this product: what the running application can request from the
browser, and what its own code refuses to request. Both were checked in source.

## 2. Permission audit

### 2.1 The policy constant

`src/lib/counter-companion.ts`:

```ts
export const COUNTER_PERMISSION_POLICY = {
  required: [] as string[],
  refused: [
    { permission: "android.permission.READ_SMS", … },
    { permission: "android.permission.READ_CALL_LOG", … },
    { permission: "android.permission.BIND_ACCESSIBILITY_SERVICE", … },
  ],
} as const;
```

The constant is documentation for a shell that does not exist. It was **not** used as
evidence on its own.

### 2.2 The real surface

Source search across `src/` for every browser permission surface:

| Capability | Requested by MaaCash? | Evidence |
| --- | --- | --- |
| SMS (`READ_SMS`, WebOTP, SMS Retriever) | No | no occurrence of `SMS`, `sms:` or `navigator.credentials` beyond password credential APIs |
| Call log | No | no occurrence |
| Accessibility service / UI automation | No | no `accessibility`, no accessibility-specific manifest, no native shell |
| Camera / microphone | No | no `getUserMedia`; evidence upload is a file input |
| Geolocation | No | no `navigator.geolocation` |
| Notifications | No | no `Notification.requestPermission` |
| Clipboard | Yes, write-only, on a button press | `src/app/access/page.tsx:67`, `src/app/susu/admin/customers/page.tsx:159`, `src/app/zeli/page.tsx:254`, `src/components/susu/SusuReceiptDocument.tsx:51` |
| Service worker | Yes, scoped to `/` | `src/lib/security/tab-session-client.ts:79` |
| Dialler | One marketing link | `src/app/(marketing)/contact/page.tsx:146` (`tel:` on the contact page) |

No sensitive permission is introduced by any dependency that ships a manifest, because no
such dependency exists.

### 2.3 Service-worker caching and confidential data

`public/tab-session-sw.js` caches, per offline scope:

- static assets, only when the path starts with `/_next/static/`, equals `/manifest.json`,
  or ends in a CSS/JS/font/image extension;
- page HTML navigations (and explicit warm requests) when an offline scope is active.

`/api/*` responses are never written to the cache, so session material and financial API
payloads are not persisted by the worker. Cached HTML is scoped per tenant/user database
name and cleared per scope.

## 3. PIN and OTP handling

| Requirement | Implementation | Test |
| --- | --- | --- |
| No field accepts a PIN | `buildCounterCapture` has no PIN input; the panel has no such field | `tests/counter-companion.test.ts` — "never stores a PIN typed into the reference" |
| A PIN-like value is refused, not stored | `looksLikeSecret()` rejects `^\d{4}$`, `^\d{5,6}$`, and anything containing `pin`, `mpin`, `otp`, `password`, `secret` | same test, 5 values asserted |
| The refusal explains what to do | message directs the agent to the network's own confirmation reference | asserted in the same test |
| A PIN/OTP cannot be logged | the capture never contains the value, so no log path receives it | by construction; the rejected value is never returned |
| The customer's number is not stored in the capture | `buildCounterCapture` returns only `customerNumberMasked` (`+233244•••11`); the queued activity carries kind, network, amount, reference, evidence reference — no phone number | `tests/counter-companion.test.ts` — "builds a capture for a confirmed customer number", "masks a number it cannot parse" |

The masked number is used for the read-back step (a human double-check). It is not
transmitted, stored in the draft payload, or written to the audit trail.

## 4. USSD handoff: what exists, and what deliberately does not

There is **no USSD handoff mechanism in the application**, and none was added.

- No `tel:`/`*`/`#` dial intent, no `android.intent.action.DIAL`, no URL scheme that would
  open the dialler with a code.
- No AccessibilityService, no overlay, no screen scraping.
- The agent performs the transaction in the network's own app or dialler and records it in
  MaaCash. `counterConfirmationLine()` states this to the agent on every capture:

  > GH₵120.50 MTN for +233244•••11 recorded on this device. It is sent to your business
  > record when you reconnect and matched when a statement is imported — the network has
  > not confirmed it to MaaCash.

This is a **scope clarification, not a defect**: the assignment's "user-controlled
USSD handoff" is satisfied in the only form the design permits — the user controls it
entirely, and MaaCash never initiates a transaction. Adding an in-app USSD launch would
create exactly the silent transaction initiation the policy forbids.

## 5. Required-test mapping

Each item from the assignment's required-test list, with its status and evidence.

| # | Required test | Status | Evidence |
| --- | --- | --- | --- |
| 1 | Supported networks and SIM selection | PASS (software) / OWNER MANUAL (SIM) | `MOMO_OFFLINE_NETWORKS = ["mtn","telecel","at_money"]`; unknown network refused — `counter-companion.test.ts` "refuses a bad flow, bad network…". SIM selection is a device action; see §6 step 6. |
| 2 | Masked Ghanaian mobile number | PASS | `maskCustomerNumber` → `+233244•••11`; asserts local, `+233` and bare-prefix forms normalise identically |
| 3 | Read-back confirmation | PASS | capture refused with "Read the number back to the customer and confirm it" until `customerNumberConfirmed` |
| 4 | Invalid and incomplete phone numbers | PASS | `12345`, `024400011`, `+2348012345678`, `abc` all refused |
| 5 | Integer-pesewa calculations | PASS | `amountMinor` integer; `tests/liquidity-forecast*` and `momo-draft` tests assert integer pesewa across the money paths |
| 6 | Zero, negative, excessive, malformed amounts | PASS | zero and negative refused; `10.005` refused (no rounding); `> 9_999_999_999` pesewa refused |
| 7 | PIN-like text rejection | PASS | see §3 |
| 8 | Empty and invalid inputs | PASS | missing flow/network/number/amount each return a field-specific refusal |
| 9 | Cancellation before handoff | PASS (by design) | there is no handoff to cancel; the save is the only action, and it writes to the device queue only |
| 10 | User-controlled USSD handoff | PASS (by design) | §4 — the user performs it; MaaCash cannot initiate |
| 11 | Device/network incompatibility | OWNER MANUAL | requires a physical SIM per network; see §6 step 6 |
| 12 | Duplicate submission | PASS | device queue uses a per-capture `idempotencyKey`; server test "is idempotent and refuses a changed payload under the same key" |
| 13 | Repeated handoff | PASS (software) | a repeated capture creates a separate queued entry that a reviewer must resolve; nothing is silently merged |
| 14 | Correct worker and branch attribution | PASS | capture row is written against the caller's session user and location; `applyMomoDraft` refuses another employee, another branch, or another day |
| 15 | Transaction record persistence | PASS (server) / OWNER MANUAL (device restart) | the draft persists in SQLite/PG through `MomoOfflineDraft`; IndexedDB persistence across a browser restart is a device check, §6 step 4 |
| 16 | `providerConfirmed` remains false unless a trusted provider record exists | PASS | literal `false` in `CounterCapture`; no code path in the repository writes `verificationStatus = "provider_confirmed"`; manual entry ignores a client-supplied value (`tests/momo-ledger.test.ts:305`) and a statement match does not promote it (`tests/provider-statement.test.ts`) |

## 6. Manual acceptance sheet (owner, physical device)

Run against the local dev server on the LAN, **or** the deployed origin once authorised.
Do not use real customer data. Use a test SIM with a small balance, and do not enter any
PIN into MaaCash — there is no field for one.

**Setup**

1. Start the app locally: `npm run dev` (or `npm run build && npx next start -p 3101`).
2. Find the development computer's LAN address: `ipconfig` → IPv4 (e.g. `192.168.1.20`).
3. On the phone, open `http://<LAN-IP>:3101`, **not** `localhost` — `localhost` on the
   phone means the phone itself and will fail.
4. Confirm the phone and computer are on the same Wi-Fi and the firewall allows the port.

**Steps and what to record**

| # | Step | Expected | Record |
| --- | --- | --- | --- |
| 1 | Sign in as the test worker | Worker workspace opens with the assigned branch | phone model, Android version, browser |
| 2 | Open the dashboard | "Counter Companion" panel is visible | screenshot (no personal data) |
| 3 | Choose *Customer sends money*, MTN, enter the test number, tap Save without the read-back tick | Refusal: read the number back first | pass/fail |
| 4 | Tick the read-back box, enter `10.00`, tap Save | Confirmation line states the amount, the masked number and that the network has not confirmed it | pass/fail |
| 5 | Enter `10.005` | Refused: at most two decimals | pass/fail |
| 6 | Switch the SIM to each network you have (MTN, Telecel, AT Money) and repeat step 4 | Each network selectable; the record shows the chosen network | which networks tested |
| 7 | Type `1234` into the reference field | Refused with the PIN/OTP warning | pass/fail |
| 8 | Reload the page (do not clear site data) | The pending-entry count is still shown when the panel is opened | pass/fail |
| 9 | Turn on Airplane Mode, capture a day in the offline panel, tap "Save on this device" | "Saved on this device… no money has been recorded" | pass/fail |
| 10 | Close the browser completely, reopen while still offline, return to the dashboard | The queued capture is still listed | pass/fail |
| 11 | Turn Airplane Mode off, wait for sync | The capture appears as awaiting completion by the worker | pass/fail |
| 12 | As the admin, open the draft review queue and the worker's daily account | The capture can be applied only to the worker's own account for the same branch and day | pass/fail |
| 13 | Check the ledger for the day | No transaction was created by the capture itself | pass/fail |

Record any carrier- or Android-version-specific difference in behaviour (for example, a
network app that refuses to run on a particular Android version, or a dialler that blocks a
USSD string). Those are network/app behaviours, not MaaCash behaviours, and should be
recorded as such.

**Not to be attempted without the owner's deliberate approval:** any real money movement,
any PIN entry anywhere, and any use of a customer's genuine number or statement.

## 7. What this document does not claim

- It does not claim the Counter Companion has been exercised on a physical Android device.
- It does not claim USSD integration exists.
- It does not claim a Play Store build, signing configuration, or store listing exists.
- It does not claim browser permission behaviour is identical on every Android OEM browser;
  only that the application never asks for a sensitive permission.
