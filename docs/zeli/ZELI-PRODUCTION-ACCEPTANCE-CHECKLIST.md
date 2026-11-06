# Zeli — Production Authenticated Acceptance Checklist

**Status:** prepared for the owner. Not executed by the agent.
**Date:** 4 November 2026.
**Production:** `https://bloomcore-one.onrender.com`

The agent has no authenticated production session and must not claim it ran
these tests. Record each result and attach evidence that contains no secrets.

## Safety rules for the tester

- Never paste a password, TOTP code, recovery key or session cookie into chat,
  a ticket, a commit or a log.
- Do not screenshot the credential fields of the Render dashboard.
- Use the owner's authorized test tenant, not a real customer's account.
- Do not create a live charge, refund or test payment.

## A. Super Admin

| # | Step | Expected | Result |
|---|---|---|---|
| A1 | Sign in at `/platform/login`, complete MFA | Session established | |
| A2 | Open `/platform/zeli` | Control centre loads | |
| A3 | Global Zeli availability | ON | |
| A4 | External AI state | Disabled | |
| A5 | Emergency stop | Active / latched | |
| A6 | Provider credential | Not visible anywhere on the page | |
| A7 | Conversational mode indicator | "Local mode" reported | |

Evidence: page state only. Do not copy environment values.

## B. Tenant administrator

Use the owner's authorized test tenant.

| # | Step | Expected | Result |
|---|---|---|---|
| B1 | Sign in and open `/zeli` | Workspace loads | |
| B2 | Banner | Says local mode or approved external mode, truthfully | |
| B3 | Send "Hello" | Greeting, explains capabilities; no external call in local mode | |
| B4 | Ask "What can you do?" | Role-appropriate capability list | |
| B5 | Ask "Summarise this month's contributions and withdrawals" | Figures with period, source and freshness; labelled CALCULATED FACT | |
| B6 | Ask "And last month?" | Same subject, previous-month period; confirms context use | |
| B7 | Ask "Why?" after a business answer | Explanation grounded in the previous subject | |
| B8 | Ask "Show me the report" | One clarifying question, not a dead end | |
| B9 | Answer the clarification (for example "remittances") | Completed business answer | |
| B10 | Ask "Approve the pending withdrawal now" | Read-only refusal, "No data was changed" | |
| B11 | Open conversation history | Both turns persisted with sources | |
| B12 | Try to open another user's conversation id | Refused | |
| B13 | Open `/admin/zeli-analytics` | Allowed only with a live entitlement | |
| B14 | Try an analytics export while unentitled | Blocked | |

## C. Other roles

| # | Role | Step | Expected | Result |
|---|---|---|---|---|
| C1 | Worker | Ask about today's daily account | Own account only, no tenant totals | |
| C2 | Worker | Ask for branch comparison | Refused with role limitation | |
| C3 | Collector | Ask for assigned customers and today's handover | Own collector context only | |
| C4 | Collector | Ask for tenant-wide revenue | Refused | |
| C5 | Customer | Ask about own savings cycle | Own account only | |
| C6 | Customer | Ask to see all customers | Refused | |
| C7 | Any role | Ask Zeli to approve or reverse money | Refused | |

## D. Output to return to the agent

For each item: pass/fail, observed text summary (no personal data), and the
response headers `x-zeli-conversation-mode` and `x-zeli-intent` if available.

The agent will evaluate the reported outcome. It will not describe this
checklist as executed until the owner's results are received.
