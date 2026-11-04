# Zeli — Provider Setup

## Current production state

External AI is **disabled**. DeepSeek is optional and never authoritative.
A key or legacy approval flag cannot enable it.

## Three states

| State | How it is enabled | What may be sent |
|---|---|---|
| Disabled | default / emergency stop | nothing |
| Synthetic | platform control + `ZELI_SYNTHETIC_TESTING_ALLOWED=true` + key | fixed synthetic packages only |
| Approved production | reviewed code constant + control + privacy version + approval reference + tenant authorization + key | approved aggregate insight package |

See `ZELI-GLOBAL-PROVIDER-CONTROLS.md` and `ZELI-DEEPSEEK-API-ARCHITECTURE.md`.

## Environment

| Variable | Purpose |
|---|---|
| `DEEPSEEK_API_KEY` | Server-only provider credential |
| `DEEPSEEK_MODEL` | `deepseek-flash` (default) or `deepseek-v4-pro` |
| `ZELI_PROVIDER` | Diagnostic only; never activates |
| `ZELI_DEEPSEEK_APPROVED` | Ignored legacy flag; never activates |
| `ZELI_SYNTHETIC_TESTING_ALLOWED` | Required for synthetic mode |
| `ZELI_PRIVACY_POLICY_VERSION` | Must match the control record for approved mode |
| `ZELI_APPROVAL_REFERENCE` | Required for approved mode |
| `ZELI_GATEWAY_MIN_COHORT` | Minimum 5; can be raised |

Never put the key in `NEXT_PUBLIC_*`, client code, HTML, logs or Git.

## Activation procedure (future)

1. DPIA/privacy assessment and legal review.
2. Owner approval and provider contract/DPA.
3. Reviewed code change to `PRODUCTION_PROVIDER_APPROVED`.
4. Match privacy policy version and approval reference.
5. Enable tenant authorization.
6. Run synthetic probe, then gateway/isolation tests.
7. Monitor latency, denials, cost and errors.
8. Keep emergency stop available.

## Synthetic probe

From `/platform/zeli` while synthetic mode is enabled, use “Run synthetic
probe”. It sends a fixed fake package; no tenant data enters that path. A live
probe was not possible here because no key was available.
