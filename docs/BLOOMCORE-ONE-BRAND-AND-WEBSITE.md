# BloomCore One — Brand and Public Website

**Status:** implemented on branch `feature/bloomcore-one-brand-public-site`.
**Owner:** BloomCore Technologies.
**Scope of this document:** product identity, logo system, palette, typography,
public marketing site, application rebrand, SEO/PWA configuration, and the
actions still required from the owner before commercial launch.

---

## 1. Brand architecture

Three names, three different jobs. They never swap places.

| Layer | Name | Where it appears | Never used for |
| --- | --- | --- | --- |
| Parent business | **BloomCore Technologies** | "A product by BloomCore Technologies", legal pages, about page, footer | The software product name |
| Product | **BloomCore One** | Marketing site, application header, login screens, PWA manifest, browser tab, Open Graph tags | The name of a customer's business |
| First tenant | **BIK Prestige Enterprise** (`BIK-HQ-001`) | Inside the BIK workspace only: tenant name next to the product name, workspace chooser, tenant-scoped records | The global brand |

Rules that follow from that hierarchy:

- BIK Prestige Enterprise is a **customer**, never the product brand.
- The product is never renamed per tenant. A second enrolled business gets its
  own name displayed next to "BloomCore One", never a replacement for it.
- "BloomCore" alone never appears as a product name. It is the shared root of
  the company name and the product name, and is always written in full as one
  or the other.

Canonical strings live in `src/lib/site.ts` and are imported by every screen
and metadata helper. Change them there, never inline.

```ts
PRODUCT_NAME       = "BloomCore One"
COMPANY_NAME       = "BloomCore Technologies"
PRODUCT_TAGLINE    = "One platform. Clearer control."
PRODUCT_DESCRIPTOR = "Business & Financial Operations Platform"
FIRST_TENANT_NAME  = "BIK Prestige Enterprise"
FIRST_TENANT_CODE  = "BIK-HQ-001"
```

---

## 2. Logo system

### 2.1 Construction

The mark is a 48×48 rounded forest tile holding an open ivory ring and a gold
core. The open ring stands for connected operational paths; the gold core is
the single control point at the centre. The wordmark is "BloomCore" in ink with
"One" in the accent gold.

Every delivered SVG is a **real vector**: the wordmark is converted to outlines
with `fontTools` from `NotoSans-Bold.ttf`, so no file depends on a font being
installed, and no file embeds a raster image or base64 payload. The mark stays
recognisable at 16×16 and 32×32 because the ring and core are geometric, not
illustrative.

### 2.2 Files

All assets live in `public/branding/` except the app-level icons.

| File | Purpose |
| --- | --- |
| `bloomcore-one-mark.svg` | Symbol only, on the forest tile |
| `bloomcore-one-mark-mono-black.svg` | Symbol only, single-colour black |
| `bloomcore-one-mark-mono-white.svg` | Symbol only, single-colour white |
| `bloomcore-one-logo.svg` | Horizontal lockup for light backgrounds |
| `bloomcore-one-logo-light.svg` | Horizontal lockup for light backgrounds (explicit light variant) |
| `bloomcore-one-logo-reversed.svg` | Horizontal lockup for forest backgrounds |
| `bloomcore-one-logo-mono-black.svg` | Horizontal lockup, single-colour black |
| `bloomcore-one-logo-mono-white.svg` | Horizontal lockup, single-colour white |
| `bloomcore-one-logo-stacked.svg` | Stacked lockup for square placements |
| `bloomcore-one-icon.svg` | App icon / maskable-safe square mark |
| `bloomcore-one-icon-192.png`, `-icon-512.png` | PWA icons |
| `bloomcore-one-icon-maskable-512.png` | PWA maskable icon (safe zone respected) |
| `bloomcore-one-favicon-16/32/48.png` | Favicon source sizes |
| `bloomcore-one-og.svg`, `-og.png` (1200×630) | Open Graph / social card |
| `src/app/favicon.ico` | 16/32/48 PNG frames in one ICO |
| `src/app/icon.svg` | Next.js app icon |
| `src/app/apple-icon.png` (180×180) | Apple touch icon |

### 2.3 Usage rules

- Pick the variant by background, never recolour by hand.
- Forest background → `logo-reversed` or the mono-white files.
- Light background → `logo` / `logo-light` or the mono-black files.
- Keep clear space around the lockup equal to the height of the gold core.
- Do not stretch, rotate, outline, or add effects to the mark.
- Minimum sizes: symbol 16 px, horizontal lockup 96 px wide, stacked lockup
  64 px wide.
- Inside the application, the identity is rendered as an inline SVG mark plus
  HTML text (`src/components/brand/Brand.tsx`, `src/components/brand/AppBrand.tsx`)
  so it inherits the app's font stack, stays selectable, and can carry the
  tenant name underneath.

### 2.4 Regenerating the assets

```bash
python scripts/build-brand-assets.py     # SVG outlines (needs fontTools)
node scripts/build-brand-raster.mjs      # PNG / ICO / OG raster (needs sharp)
```

The generator reads `C:\Windows\Fonts\NotoSans-Bold.ttf` on Windows. Change
the geometry there, not in the output files.

---

## 3. Colour palette

| Token | Hex | Role |
| --- | --- | --- |
| Forest | `#0E4D34` | Brand primary, headers, primary buttons, dark surfaces |
| Gold | `#C9A227` | Brand accent, used sparingly: active indicators, highlights, small marks |
| Ivory | `#F6F5EC` | Public-site background surfaces |
| Ink | `#17211C` | Deep text colour on light surfaces |

Supporting ramps live in `src/app/globals.css` under `@theme`: `brand-50…950`,
`gold-50…900`, `ivory`, `ivory-deep`, `ink`, `ink-muted`, `ink-faint`, plus the
semantic `success`, `danger`, `warning`, and `info` roles. Bright green
(`#16a34a`) remains the **success** semantic and is not the brand primary.

### 3.1 Accessibility rule for the gold accent

Accent gold `#C9A227` reaches only 2.4:1 on white and 2.2:1 on ivory, so it
is never used for body text on a light surface. The ramps exist for this:

| Usage | Token | Contrast on light surfaces |
| --- | --- | --- |
| Gold text on white/ivory | `gold-700` `#86691B` | 5.2:1 / 4.7:1 |
| Gold text on forest | `gold-400` `#D4AC33` | 6.6:1 on `brand-900` |
| Gold fill on dark text | `gold-500` background with `brand-950` text | 7.0:1 |

Muted text was darkened for the same reason: `ink-muted` is `#4E5B6E`
(6.9:1 on white, 6.3:1 on ivory) and `ink-faint` is `#5A6878` (5.7:1 / 5.2:1).

---

## 4. Typography

- One family: **Noto Sans**, kept from the existing product.
- The webfont is imported at the top of `src/app/globals.css`.
- The body stack is `system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans", sans-serif`
  so the rendered look is unchanged while the cedi sign (U+20B5) still falls
  back to Noto Sans on devices that lack it.
- Weights used: 400 (body), 500 (labels), 600 (headings, buttons), 700 (rare).
- The SVG wordmark does not depend on this stack; it is already outlined.

---

## 5. Public marketing site

Seven public routes, all HTTP 200 with no session, no database access, and no
authentication side effects:

| Route | Purpose |
| --- | --- |
| `/` | Landing page: what the product is, who it is for, how it works, what it costs to start |
| `/features` | Module-by-module capability list, written from the deployed application |
| `/solutions` | Who the product serves, and what it does not do |
| `/about` | The business behind the product, and the brand hierarchy |
| `/contact` | Demonstration request path |
| `/privacy` | How data is actually handled (draft, see §9) |
| `/terms` | Terms of service (draft, see §9) |
| `/workspace` | Entry point for signed-in users: redirect-only, no content |

Implementation notes:

- The pages live in the route group `src/app/(marketing)/`. The former
  `src/app/page.tsx` was deleted, so the route group owns `/`.
- The group has its own `error.tsx`, so a failure on a marketing page never
  shows application wording or a link into a signed-in workspace.
- Public access is granted in `src/middleware.ts` by `isPublicMarketingRoute()`
  from `src/lib/public-routes.ts`. The check runs **after** the platform
  boundary and **before** every tenant rule, and matches only exact routes or
  sub-paths on a segment boundary. `/featuresecret` is not public.
- Signing in is reached through the visible **Sign In** link, which points at
  `/workspace`. That URL is handled entirely in the middleware as a redirect:
  a signed-in person goes straight to the workspace their session covers
  (platform, admin, MoMo, Susu or customer), an anonymous visitor goes to
  `/login`, and nobody ever sees content at that URL. Explicit per-role entry
  points stay on `/access`, and `/login` keeps its role picker. `"/"` itself
  stays genuinely public for every visitor, including signed-in ones.
- A mistyped URL still follows the application's baseline rule: an anonymous
  visitor is redirected to `/login` rather than shown a 404, because the
  middleware deliberately requires a session for any route it does not
  recognise. The neutral 404 page (`src/app/not-found.tsx`) renders for a
  signed-in user who follows a dead link.
- Shared building blocks are in `src/components/marketing/Sections.tsx`,
  `MarketingNav.tsx`, and `MarketingFooter.tsx`.

### 5.1 Content rules

The public site describes only what the deployed application does. The site
contains **no** invented numbers, customer logos, testimonials, certifications,
security claims, regulatory claims, or performance statistics. Legal pages
carry a visible draft notice until they are reviewed.

The company is described as "a business based in Ghana". Its **legal form is
not asserted anywhere** on the public site — no registration claim, business
type, or registration number appears until the owner confirms it and asks for
it to be published.

---

## 6. Application rebrand

| Surface | Change |
| --- | --- |
| Unified login (`/login`) | BloomCore One lockup, Lucide `Lock` icon in place of the emoji |
| Admin login (`/admin/login`) | BloomCore One lockup and product wording |
| Platform login (`/platform/login`) | Reversed lockup on forest |
| Platform console shell | "BloomCore One · Platform Administration", product lockup in the sidebar |
| Tenant shell (`/components/AppShell.tsx`) | `AppBrand` shows "BloomCore One" with the resolved tenant name underneath |
| Admin / worker / collector / customer layouts | `AppBrand`, tenant-aware, Lucide icons replace emoji |
| Workspace chooser (`/select-workspace`) | `AppBrand` plus the resolved tenant name |
| Password recovery and reset screens | Product lockup and product wording |
| Access page (`/access`) | Product wording, renamed QR download filenames |
| Application errors and 404 | Product wording; the error page links back to sign-in, the 404 links to the public home page and sign-in |
| Sign-out confirmation | Product name, not a tenant name |
| PWA manifest | BloomCore One name, forest theme colour, ivory background colour, new icons, `start_url` `/workspace` |
| Browser tab / favicon / Apple icon | New vector assets |

`EnvironmentBadge` (the internal deployment marker) is hidden on public
marketing routes and visible everywhere else.

### 6.1 What did not change

No authentication or tenancy behaviour was modified. Specifically unchanged:

- `PlatformSuperAdmin` model and the role model.
- Session cookie names: `bik-admin-session`, `bik-worker-session`,
  `bik-collector-session`, `bik-customer-session`, `bik-workspace-select`,
  `bik-platform-session`, legacy `bik-prestige-token`.
- JWT signing and verification, and the `JWT_SECRET` requirement.
- Tenant resolution, `tokenVersion` enforcement, and token/session timing rules.
- Middleware guards for every application route, and the one-way platform
  boundary.
- Tenant entitlement checks.
- Password hashing and the password policy.
- The platform cookie, which remains outside `SESSION_COOKIES`.

The only middleware edits are the addition of the marketing allowlist and the
addition of `/workspace` to the existing public-route list. `/workspace`
renders nothing and exposes nothing — it only redirects. `tests/middleware-boundaries.test.ts`
pins the important behaviour: anonymous access to protected pages still
redirects, forged cookies are still rejected, and a platform session still
cannot act as a tenant user (and the reverse).

---

## 7. SEO and metadata

| Item | Behaviour |
| --- | --- |
| Page titles | Root layout template `%s · BloomCore One`; the home page uses an absolute title so the product name is not repeated |
| Description | One factual sentence per page, taken from `PRODUCT_POSITIONING` or page-specific text |
| Open Graph / Twitter | Site name, title, description, and `/branding/bloomcore-one-og.png` (1200×630) |
| Canonical URLs | Emitted **only** when `SITE_URL` or `NEXT_PUBLIC_SITE_URL` is set. The temporary deployment never claims to be the canonical home of the brand |
| `sitemap.xml` | The five marketing routes plus the two legal routes. No authenticated route is listed |
| `robots.txt` | Marketing routes allowed; `/admin`, `/api`, `/collector`, `/customer`, `/platform`, `/select-workspace`, `/settings`, `/susu`, `/worker`, `/access`, `/change-password`, `/forgot-password`, `/login`, `/reset-password` disallowed |
| `lang` | `<html lang="en">` |

### 7.1 Environment variables

| Variable | Purpose | Current state |
| --- | --- | --- |
| `SITE_URL` | Canonical public origin. Drives metadata base, sitemap, robots, Open Graph URLs | **Unset** — falls back to the temporary Render host `https://bik-prestige-enterprise-pcxi.onrender.com` |
| `NEXT_PUBLIC_SITE_URL` | Client-visible fallback for the same origin | **Unset** |
| `CONTACT_EMAIL` | Public enquiry email | **Unset** |
| `CONTACT_PHONE` | Public enquiry telephone | **Unset** |

---

## 8. Contact page

No verified BloomCore Technologies business email or telephone exists, so
`CONTACT_EMAIL` and `CONTACT_PHONE` are unset and `CONTACT_CONFIGURED` is
false. The `/contact` page says plainly that no public enquiry channel has been
published yet, and lists exactly what must be supplied:

1. A monitored business email address for enquiries.
2. A business telephone number with the hours it is answered.
3. The postal or registered-office address, if the owner wants it published.

There is **no** form that pretends to submit. No message is stored, no
third-party service is called, and no success state is shown for a message
that was never sent. Once a channel is configured, the page renders the real
contact details and the same enquiry path.

---

## 9. Legal pages

`/privacy` and `/terms` are written from what the deployed application
actually does, and both carry a visible **Draft — pending owner and legal
review** notice. They are not legal advice and are not an agreement. They must
be reviewed before commercial launch, and they cannot name a data-protection
contact until a verified channel exists (§8).

---

## 10. Verification performed

All checks below were run against a **production build** (`npm run build`)
served locally with `npm start`, using the local SQLite development database.
No production database was touched.

**Automated tests**

- `npm test` → 14 files, **215 tests passed** (baseline was 196; 19 added by
  `tests/public-routes.test.ts` and `tests/middleware-boundaries.test.ts`).
- `npm run typecheck` → clean.
- `npm run lint` → **0 errors**, 73 warnings (baseline 76).
- `npm run build` → compiled successfully, 58 static pages generated.

**Runtime behaviour (production server)**

- HTTP 200: `/`, `/features`, `/solutions`, `/about`, `/contact`, `/privacy`,
  `/terms`, `/robots.txt`, `/sitemap.xml`, `/manifest.json`, `/login`,
  `/access`, `/admin/login`, `/platform/login`, `/customer/login`,
  `/forgot-password`, every brand asset, `/favicon.ico`, `/icon.svg`,
  `/apple-icon.png`.
- HTTP 307 to the correct sign-in page: `/admin/dashboard` → `/login`,
  `/worker/dashboard` → `/login`, `/collector/dashboard` → `/login`,
  `/customer/dashboard` → `/login?role=customer`,
  `/platform/dashboard` → `/platform/login`, `/susu/admin`, `/settings`,
  `/select-workspace`.
- A forged `bik-admin-session` cookie still redirects to `/login`.

**Responsive** — `node scripts/check-responsive.mjs http://localhost:3111`

- No horizontal overflow at 320, 360, 390, 768, 1024, 1440 and 1920 px across
  all seven public pages.

**Accessibility** — `node scripts/check-accessibility.mjs http://localhost:3111`

- axe-core 4.10.2, WCAG 2.1 A/AA rule tags: **0 violations** on all seven
  public pages.
- One `h1` per page, zero heading-level jumps, one `header`/`nav`/`main`/`footer`
  landmark set per page, a working "Skip to content" link, no unlabelled form
  controls, no missing alt text.
- Both verification scripts wait for the page to finish rendering before
  measuring, so a half-loaded document cannot produce a false pass.

---

## 11. Owner actions before launch

1. **Confirm the public domain.** Set `SITE_URL` (server-side) or
   `NEXT_PUBLIC_SITE_URL` to the final origin, then rebuild. Canonical tags
   are emitted only after this is set.
2. **Supply a verified contact channel.** Set `CONTACT_EMAIL` and
   `CONTACT_PHONE` with the hours the number is answered.
3. **Review `/privacy` and `/terms` with a legal adviser.** Both pages still
   carry their draft notice until you remove it.
4. **Decide the launch status of the product.** The public site describes a
   deployed platform. Confirm that the wording on `/features` and `/solutions`
   matches what you intend to sell.
5. **Optionally publish a postal address** on `/contact`.
6. **Optionally publish the company's legal form.** The site currently says
   only "a business based in Ghana". If the registered form (for example sole
   proprietorship) and registration number should appear, confirm the exact
   wording first.

---

## 12. File map

| Path | Purpose |
| --- | --- |
| `src/lib/site.ts` | Every canonical brand string, route list, and environment-backed setting |
| `src/lib/public-routes.ts` | The public marketing route allowlist and matcher |
| `src/lib/metadata.ts` | `pageMetadata()` helper used by every public page |
| `src/components/brand/Brand.tsx` | `BrandMark` and `BrandLockup` |
| `src/components/brand/AppBrand.tsx` | Tenant-aware application identity |
| `src/components/marketing/` | Nav, footer, shared page sections |
| `src/app/(marketing)/` | The seven public pages plus the marketing error screen |
| `src/app/not-found.tsx` | Neutral 404 for signed-in users who follow a dead link |
| `src/app/sitemap.ts`, `src/app/robots.ts` | Search-engine files |
| `public/branding/` | Generated brand assets |
| `scripts/build-brand-assets.py` | SVG generator (wordmark outlines) |
| `scripts/build-brand-raster.mjs` | Raster generator (PNG, ICO, OG) |
| `scripts/check-responsive.mjs` | Viewport overflow check |
| `scripts/check-accessibility.mjs` | axe-core audit |
| `tests/public-routes.test.ts` | Public route list and brand-string regression tests |
| `tests/middleware-boundaries.test.ts` | Authentication boundary regression tests |

---

## 13. Promotion to `main`

This branch is not yet promoted. When it is ready, follow
`PRODUCTION-RELEASE-RUNBOOK.md` stage 5:

```bash
git push origin feature/bloomcore-one-brand-public-site:main   # fast-forward only, never --force
curl -s https://bik-prestige-enterprise-pcxi.onrender.com/api/health
curl -s -o /dev/null -w '%{http_code}\n' https://bik-prestige-enterprise-pcxi.onrender.com/api/health/ready
```

The deployed commit SHA must equal the promoted `main` SHA.
