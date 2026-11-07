# MaaCash

**Mobile Money, Susu & Multi-Branch Financial Operations Platform** — a product
of [BloomCore Technologies](https://github.com/Delkay-byte/BloomCore-One).

MaaCash brings mobile-money (MoMo) accounts, Susu collections, multi-branch
operations, people and financial records together in one connected platform.
Businesses are enrolled onto the platform with their own isolated workspace;
each workspace has its own users, customers, records and history.

> Formerly BloomCore One. The product identity changed; the platform, data,
> accounts and financial history did not.

The first tenant on the platform is **BIK Prestige Enterprise** (`BIK-HQ-001`)
— a customer of the platform with its own identity inside its own workspace.
It is not the name of the product.

## Modules

| Module | Purpose |
| --- | --- |
| MoMo | Daily mobile-money accounts: locations, workers, the open → operate → reconcile → submit → review workflow, expenses, reports and CSV export |
| Susu | Customer collections and contributions: collectors, daily contributions, cycles, withdrawals, remittances and statements |
| Customer portal | Customers sign in to view their own statement, payments and withdrawals |
| Platform console | BloomCore Technologies' control plane: enrol businesses, manage tenants, view the platform activity trail |

## Architecture

- **Next.js (App Router)** application with server actions and route-level
  middleware guards.
- **PostgreSQL (Neon)** in production, **SQLite** for local development and
  tests — selected by `DATABASE_URL` and the matching Prisma schema
  (`prisma/schema-pg.prisma` in production, `prisma/schema.prisma` locally).
- **Module-scoped sessions:** each module writes only its own signed,
  http-only cookie. The platform console is one-way isolated from tenant
  workspaces: platform sessions can never act as tenant users and vice versa.
- **Tenant isolation:** every query is scoped to the signed-in user's tenant,
  resolved server-side on every request.
- **PWA:** installable, with an offline-capable collection flow for field
  roles.

```
src/
  app/            Routes: marketing site, admin, worker, collector, customer, platform
  components/     UI + brand components
  lib/            Auth, tenancy, actions, offline store, site configuration
  middleware.ts   Route protection (platform boundary → public marketing → tenant rules)
prisma/           Prisma schemas (SQLite + PostgreSQL), migrations, seed
public/branding/  MaaCash brand assets (vector SVG + raster)
scripts/          Asset generation, deployment and verification helpers
tests/            Vitest suite (security, tenancy, workflows, boundaries)
```

## Brand

- Product: **MaaCash** — never renamed per tenant.
- Parent business: **BloomCore Technologies**.
- Palette: forest `#0E4D34`, gold `#C9A227`, ivory `#F6F5EC`, ink `#17211C`.
- Typography: Noto Sans.
- Assets and usage rules: `docs/branding/MAACASH-REBRAND-INVENTORY.md` and
  `docs/branding/MAACASH-REBRAND-MIGRATION-REPORT.md`.
- The marketing site lives in `src/app/(marketing)/` and is public:
  `/`, `/features`, `/solutions`, `/about`, `/contact`, `/privacy`, `/terms`.

## Development

```bash
npm install
npx prisma generate              # SQLite client for local dev/tests
DATABASE_URL="file:./dev.db" npm run dev
```

The SQLite database file is created under `prisma/`. Seed it with:

```bash
npx tsx prisma/seed.ts
```

## Verification

```bash
npm test            # full Vitest suite
npm run typecheck   # tsc --noEmit
npm run lint        # eslint
npm run build       # production build
```

Asset regeneration (after a brand geometry change):

```bash
python scripts/build-brand-assets.py
node scripts/build-brand-raster.mjs
```

## Deployment

Production runs on Render (web service `bloomcore-one`, service ID
`srv-dbjalrk9v7es739ifkp0`) with a Neon PostgreSQL database. The service name
and `onrender.com` hostname are preserved infrastructure identifiers; the
public product identity is MaaCash. `main` is the production branch and
auto-deploys. The build command generates the PostgreSQL Prisma client before
`next build`; database schema changes are applied with explicit
`prisma migrate deploy` runs by the operator — never by a build. Full details:
`docs/NEON-RENDER-DEPLOYMENT.md` and `PRODUCTION-RELEASE-RUNBOOK.md`.

Public configuration (set in the Render dashboard, never in Git):

| Variable | Purpose |
| --- | --- |
| `SITE_URL` / `NEXT_PUBLIC_SITE_URL` | Canonical public origin for metadata, sitemap and robots |
| `CONTACT_EMAIL` / `CONTACT_PHONE` | Public enquiry channel shown on `/contact` |

## Documentation

- `docs/NEON-RENDER-DEPLOYMENT.md` — infrastructure and deployment
- `PRODUCTION-RELEASE-RUNBOOK.md` — release/promotion process
- `docs/branding/MAACASH-REBRAND-INVENTORY.md` — rebrand impact inventory
- `docs/branding/MAACASH-REBRAND-MIGRATION-REPORT.md` — rebrand record
- `docs/branding/MAACASH-DOMAIN-OPTIONS.md` — domain research and pending decision
- `docs/BLOOMCORE-ONE-BRAND-AND-WEBSITE.md` — historical brand record (formerly BloomCore One)
- `docs/BRANCH-REVIEW-BLOOMCORE-ONE.md` — historical branch review record
- `SECURITY.md` — security model and reporting
