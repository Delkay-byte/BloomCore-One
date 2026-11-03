# Zeli — Provider Setup and DeepSeek Activation

## Default: mock

`ZELI_PROVIDER` unset or `mock` uses the deterministic local provider. It needs
no credentials and sends no data externally.

## DeepSeek activation checklist

Do not send tenant data until every item is true:

1. Written DPA/privacy and contractual approval is on file.
2. Owner approves external processing for the intended environment.
3. Set `ZELI_DEEPSEEK_APPROVED=true` (otherwise the adapter refuses to run).
4. Set `DEEPSEEK_API_KEY` as a secret in the hosting environment only.
5. Set `ZELI_PROVIDER=deepseek`.
6. Optionally set `DEEPSEEK_MODEL` (default `deepseek-chat`) and
   `DEEPSEEK_BASE_URL` if required by the provider.
7. Verify in staging with synthetic data only.
8. Confirm the UI shows the provider as available; confirm stop/timeout/error
   behaviour.
9. Review the first production week's usage, failures and cost.
10. Keep a documented disable path: set `ZELI_PROVIDER=mock` (or remove the key)
    and redeploy.

Without approval or key the UI says the provider is disabled, no data is sent,
and the conversation still persists safely.

## Environment

| Variable | Purpose |
|---|---|
| `ZELI_PROVIDER` | `mock` or `deepseek` |
| `ZELI_DEEPSEEK_APPROVED` | Must be `true` before any external call |
| `DEEPSEEK_API_KEY` | Secret; never committed |
| `DEEPSEEK_MODEL` | Optional model override |
| `DEEPSEEK_BASE_URL` | Optional API base |

No provider secret belongs in Git, browser code or the external-test pack.
