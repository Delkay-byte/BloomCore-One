# Zeli — Enhanced AI Real-Provider Evidence

**Environment:** `bloomcore-one-staging`
**Date:** 4 November 2026
**Status:** pending the staging deployment and probe run.

This file records metadata only. It must never contain message content,
business figures, customer data or credentials.

## Method

The deployed staging application exposes a temporary acceptance probe:

`POST /api/zeli/acceptance/probe`

Guards: `APP_ENV=STAGING`, `ZELI_ACCEPTANCE_PROBE=enabled`, a 32+ byte token,
a fixed synthetic tenant and two fixed questions. It returns metadata only.

Two turns are run on the real deployed server, against the real staging
database, using the real DeepSeek credential already configured in staging:

1. "Give me a summary of the business this month."
2. "Compare that with last month."

## Result

To be recorded after the run: provider, model, decision, latency, token counts,
tool names, mode, context use and numeric-integrity result.
