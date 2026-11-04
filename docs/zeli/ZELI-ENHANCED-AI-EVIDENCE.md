# Zeli — Enhanced AI Real-Provider Evidence

**Environment:** `bloomcore-one-staging`
**Date:** 4 November 2026
**Status:** **BLOCKED — staging provider credential rejected (HTTP 401).**

This file records metadata only. It must never contain message content,
business figures, customer data or credentials.

## Method

The deployed staging application exposes a temporary acceptance probe:

`POST /api/zeli/acceptance/probe`

Guards: `APP_ENV=STAGING`, `ZELI_ACCEPTANCE_PROBE=enabled`, a 32+ byte token,
a fixed synthetic tenant and two fixed questions. It returns metadata only.

Two turns are run on the real deployed server, against the real staging
database, using the DeepSeek credential already configured in staging:

1. "Give me a summary of the business this month."
2. "Compare that with last month."

## Deployment

| Item | Value |
|---|---|
| Staging service | `bloomcore-one-staging` |
| Code SHA | `3af612b327117e96e9375317308bcbe501672134` |
| Deploy status | live |
| Environment | `APP_ENV=STAGING` |
| Provider control | `synthetic`, enabled, emergency stop off |
| Credential configured | true (boolean check only) |
| Synthetic flag | true |

## Probe result

Both turns returned `mode: local`, `provider: internal`, no tools executed.
The provider audit row recorded:

```
decision:        error
reasonCategory:  provider_status_401:authentication_error
purpose:         chat:none
```

The request reached DeepSeek and was rejected at authentication. No business
data was transmitted beyond the request envelope, and no answer was accepted
from the provider.

A previous staging probe on 3 November 2026 succeeded with the then-configured
credential (2,002 ms, 257 input tokens, 190 output tokens). The current staging
credential is therefore not the rotated credential, or it has been revoked.

## Owner action required

The agent must not read, copy or display the rotated key. Update the staging
secret from the owner's authorized secret store:

1. Render Dashboard → `bloomcore-one-staging` → Environment.
2. Set `DEEPSEEK_API_KEY` to the existing rotated credential. Do not create a
   new key.
3. Alternatively, create a narrowly scoped environment group containing only
   `DEEPSEEK_API_KEY` and link it to staging. Do not link the production group.
4. Save and let the service restart.
5. Do not paste the key into chat, a ticket, a commit or a log.

After the update, use staging `/zeli` as a tenant administrator. A successful
Enhanced AI turn shows the `Enhanced AI — TEAM ACCEPTANCE MODE` banner and an
external answer badge. If the provider still fails, Zeli falls back to Local
mode and no answer is lost.

## What is proven

- The staging code is deployed and running.
- The tool orchestration path is reachable.
- Authentication failure degrades safely to the local assistant.
- No provider content or credential was recorded.

## What is not proven

- A successful live DeepSeek conversation in staging.
- Real tool execution against the staging database through the provider.
- Model explanation of real synthetic staging figures.

This remains **NOT VERIFIED** until the staging credential is corrected and the
probe or a team conversation succeeds.

