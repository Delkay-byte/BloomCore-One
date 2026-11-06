# MaaCash — Domain Options and Decision Record

**Date:** 2026-11-06
**Status:** Research only. **Nothing purchased. No DNS changed.**
**Decision owner:** BloomCore Technologies

The owner has confirmed that no domain will be purchased yet. The product keeps
using the existing free Render hostname until a domain is approved. This
document records what was checked so the decision can be made later without
repeating the work.

---

## 1. Availability checks performed

Registry RDAP was queried directly on 2026-11-06:

- `.com` — Verisign RDAP
- `.app` — Google Registry RDAP
- `.io` — RDAP redirect
- `.africa` — NIC Africa RDAP
- `.com.gh` — no RDAP record returned

RDAP returning **no registration record** is evidence, not proof, of
availability. A registrar checkout is the authoritative test. Prices move and
premium tiers exist.

| Domain | Registry signal 2026-11-06 | Indicative first-year price (USD) | Indicative renewal (USD) | Status |
| --- | --- | --- | --- | --- |
| `maacash.com` | No RDAP registration record found | 10–20 | 15–25 | **Preferred, verify at registrar** |
| `maacash.app` | No RDAP registration record found | 15–25 | 15–30 | Available candidate |
| `maacash.io` | No RDAP registration record found | 30–60 | 30–70 | Expensive; verify |
| `maacash.africa` | No RDAP registration record found | 10–25 | 15–30 | Regional option |
| `maacash.com.gh` | Registry RDAP unavailable | Registrar quote required | Registrar quote required | **Local option, verify with Ghana registrar** |
| `maacash.co` | Not checked | 20–40 | 25–50 | Fallback |
| `mymaacash.com` | Not checked | 10–20 | 15–25 | Fallback |
| `getmaacash.com` | Not checked | 10–20 | 15–25 | Fallback |

Prices are indicative retail ranges, not quotes. Confirm with the chosen
registrar before approval.

---

## 2. Reputation and naming risks found

### `maacash.com` abuse history

Public abuse datasets list historical subdomains of `maacash.com` in
cryptocurrency-scam URL feeds. The registry currently returns no registration
record, which suggests the domain expired or was dropped. This is a **material
reputation risk** for a financial platform.

Before purchase:

1. Run the exact domain through Google Safe Browsing, URLhaus and VirusTotal.
2. Ask the registrar whether the name is premium or previously abused.
3. Prefer a fresh registration only after the reputation check is clean.
4. If the history cannot be cleared, use `maacash.africa` or `maacash.com.gh`
   as the primary and keep `.com` as a redirect only if clean.

### Similar names

- **Mama Cash** (`mamacash.org`) is an established Dutch feminist fund. The
  names are not identical, but they sound close. Do not use logos or wording
  that could imply affiliation.
- "Maa" is a common Ghanaian honorific. The name reads naturally in the target
  market, but a local company-name search is still required.
- No registered "MaaCash" trademark was found in the limited public search
  performed. **This is not legal clearance.**

### Required checks before purchase

- Ghana Registrar General company-name search.
- WIPO Global Brand Database and Ghana trademark registry.
- A short trademark opinion from a qualified practitioner if the product will
  process customer money under the name.

---

## 3. Recommended structure (when a domain is approved)

If the approved domain is `maacash.<tld>`:

| Purpose | Hostname | Notes |
| --- | --- | --- |
| Production application | `app.maacash.<tld>` | Canonical public origin |
| Staging application | `staging.maacash.<tld>` | Optional; only if staging should be public |
| Marketing site | `maacash.<tld>` | Redirect to `app.` or serve the same Next.js app |
| API | none | Next.js route handlers already serve the API on the same origin |

Do **not** create `api.` unless a separate API host is genuinely required.
The current architecture serves API routes from the application origin.

If a shorter setup is preferred, `maacash.<tld>` can serve both marketing and
application; `app.maacash.<tld>` is the safer canonical origin for cookies,
service-worker scope and future expansion.

---

## 4. Render custom-domain steps (for later, not executed)

1. Owner registers the domain and chooses the DNS provider.
2. In Render, open the production service → **Settings → Custom Domains**.
3. Add the chosen production hostname. Render displays the exact DNS target.
4. Copy Render's exact values into DNS. Do not invent targets.
5. Add the staging hostname to the staging service if approved.
6. Wait for Render to verify ownership and issue TLS.
7. Confirm HTTPS, canonical redirects and absence of redirect loops.
8. Add the new hostname to `TURNSTILE_ALLOWED_HOSTNAMES` and
   `ALLOWED_ORIGINS`; keep the old hostname during transition.
9. Set `SITE_URL`, `NEXT_PUBLIC_SITE_URL` and `NEXTAUTH_URL` to the new origin.
10. Update OIDC redirect URI and Paystack webhook only after the new route is
    verified.
11. Keep `bloomcore-one.onrender.com` reachable for rollback.
12. Add HSTS only after HTTPS is confirmed on the new host.

### DNS records

Only Render's displayed values are valid. Typical Render custom-domain records
are a CNAME for a subdomain or an A/ALIAS record for an apex. The exact values
must come from the Render dashboard at the time of setup. This document does not
invent them.

### Email records

No email sending exists today. If email is added later, SPF, DKIM and DMARC
records are required for the chosen sending domain. They are not part of the
web hosting DNS change and need separate owner approval.

---

## 5. Registrar assessment

| Registrar | Strengths | Watch-outs |
| --- | --- | --- |
| Cloudflare Registrar | At-cost renewals, excellent DNS, free proxy/WAF options | Requires Cloudflare DNS; limited TLD list |
| Namecheap | Clear pricing, good UI, wide TLD support | Upsells at checkout |
| Name.com | Good API and DNS | Renewal pricing can rise |
| GoDaddy | Widely available, Ghana-friendly support | Aggressive upsells; renewal pricing |
| Local Ghana registrar | `.com.gh` and local compliance | Verify accreditation and DNS quality |

**Recommendation:** buy through Cloudflare Registrar if the chosen TLD is
supported; otherwise Namecheap. Use Cloudflare DNS for the domain regardless of
registrar.

---

## 6. Decision

- **Selected domain:** none yet.
- **Purchase:** not authorised, not performed.
- **Current public identity:** existing free Render hostname.
- **Product identity:** MaaCash is applied in the application now.
- **Next action:** owner selects a domain and explicitly approves the purchase.

Legal clearance is **not** claimed. Availability and trademark checks must be
repeated at purchase time.
