# Zeli — Global Provider Controls

## One policy service

`src/lib/zeli/provider-control.ts` resolves the effective state. Every external
path calls it before constructing a request.

### Inputs

- `ZeliProviderControl` row (mode, enabled, emergency flag, provider, purposes,
  policy version, approval reference).
- `PRODUCTION_PROVIDER_APPROVED` reviewed code constant (currently `false`).
- Server environment: API key, privacy policy version, approval reference,
  synthetic-testing permission.
- Per-tenant AI authorization row.

### States

| State | Conditions | Behaviour |
|---|---|---|
| disabled | default, emergency stop, missing provider/key, unsupported mode | local only |
| synthetic | control=synthetic, enabled, env permission, key | synthetic packages only |
| approved | all production gates | aggregate package only |

## Emergency stop

- Platform action sets `emergencyDisabled=true`, `mode=disabled`, `enabled=false`.
- It overrides all other settings immediately.
- It is audited with actor, reason and time.
- It is the fastest way to stop outbound processing.

## What cannot enable production

- An API key alone.
- `ZELI_PROVIDER=deepseek`.
- `ZELI_DEEPSEEK_APPROVED=true`.
- A Super Admin UI selection.
- A database row alone.

The reviewed code constant must change, and the privacy version, approval
reference and tenant authorization must all match.

## Platform UI

- Shows effective state and reason.
- Allows disable, synthetic enable (when environment permits), emergency stop
  and synthetic probe.
- Production selection is rejected with an explanation.
- Displays 24-hour request/denial/failure counts.
- Never displays a provider key.

## Operational rules

- No background provider requests.
- No retries for rejected payloads.
- No provider fallback.
- No browser-side key.
- A provider outage does not affect analytics/private answers.
- Synthetic probes use a fixed fake package and are audited.
