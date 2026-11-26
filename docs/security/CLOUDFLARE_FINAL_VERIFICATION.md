# Cloudflare final verification

Date: 25 November 2026. No authenticated Cloudflare access was available.

All zone-level controls are **Unverified**: DNS proxy status, DDoS plan
coverage, WAF managed rules, custom rules, edge rate limits, bot features,
security events, alerts and origin restrictions. Response headers seen in
earlier audits prove only that DNS is proxied.

Owner checklist (setting → recommended → why → plan → verify → safe test):

| Setting | Recommended | Why | Plan | Verify | Safe test |
| --- | --- | --- | --- | --- | --- |
| DNS proxy | Proxied on canonical domain | Edge in path | All | Orange cloud | GET public page |
| Automatic DDoS | Enabled | L3/4 baseline | All plans | Security → DDoS status | Read status only |
| WAF managed rules | Enabled, log first | Common exploits | Plan-dependent | WAF ruleset ID/version | Log mode, then selective block |
| Custom WAF rules | Log/simulate initially | Avoid false positives | Plan-dependent | Rule ID + action | Staging journeys |
| Edge rate limits | High-risk public routes only | Abuse control | Plan-dependent | Rule scope | Non-mutating requests |
| Bot protection | Selective, never blanket | Preserve field devices | Plan-dependent | Bot mode | Login/API/callback tests |
| Alerts | Owner notified | Visibility | Plan-dependent | Notification target | Trigger test event |
| Origin restriction | Canonical origin only | Prevent bypass | Config-dependent | Direct-origin probe | Owner-authorised probe |

Do not claim any control is active without live evidence. No live setting was
changed.
