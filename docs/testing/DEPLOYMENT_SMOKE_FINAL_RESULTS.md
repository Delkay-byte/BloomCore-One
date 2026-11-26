# Deployment smoke final results

Date: 25 November 2026. Release HELD.

Six checks in `e2e/deployment-smoke.spec.ts` require `MAACASH_CANONICAL_ORIGIN`
and `MAACASH_LEGACY_ORIGIN`. No authorised isolated staging environment was
available, so **none were executed**. Unexecuted tests are not reported as passed.

Classification: all six are read-only public GET/HEAD checks; none creates or
mutates data. Two depend on the canonical domain metadata, two on sitemap/robots
and service-worker scope, two on the legacy transition host.

Release-stage instructions: after owner authorises a verified non-production
staging deployment with synthetic data, set both origin variables and run
`npm run test:e2e:deployment`. Report results separately from local E2E.
Status: **Deployment-stage verification required**.
