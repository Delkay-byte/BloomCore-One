<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## MaaCash engineering instructions

Canonical standard: **BloomCore Secure Engineering & Real-World Quality Standard v1.0** (`BC-SEC-STD-001`), private repository https://github.com/Delkay-byte/BloomCore-Engineering-Standards (requires GitHub authentication). Global rules and these project rules apply together.

For code, API, authentication, data, integration, infrastructure, test, security or release work, load `@bloomcore-secure-engineering`. Treat tenant boundaries, server-side authorisation, business invariants, privacy, reliability and realistic tests as acceptance criteria.

Documentation locations: `docs/private/` (confidential product/operations compendium), `docs/security/`, `docs/testing/`, and the product reports under `docs/`. Read the applicable document before changing behaviour. Do not copy confidential product facts into global or company-wide files.

Verified commands from `package.json` (run the relevant set and record exact results; never assume they pass): `npm run typecheck`, `npm run lint`, `npm test`, `npm run build`, `npm run test:e2e`, `npm run test:pg` and the `db:migrate:status` / `db:migrate:prod` scripts. Use only isolated databases and synthetic data for tests.

Never expose secrets or real customer data. Never run destructive, stress or DDoS tests against production. Never weaken authentication, authorisation, tenant isolation, privacy controls or CI gates. Do not push, merge, change production settings or deploy without explicit owner approval.
