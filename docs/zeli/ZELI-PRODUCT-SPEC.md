# Zeli — Product Specification (implemented)

**Version:** 2026-11-02
**Status:** Implemented on `feat/zeli-complete-assistant-2026-11`
**Brand:** part of BloomCore One; forest `#0E4D34`, gold `#C9A227`, ivory `#F6F5EC`, ink `#17211C`, Noto Sans.

## Purpose

Zeli is the built-in business and financial operations assistant. It answers
questions from the signed-in user's authorized records, explains figures and
points to the normal screen for any action.

## Available now

- Dedicated `/zeli` workspace, responsive desktop/tablet/mobile.
- Conversation list, new conversation, rename, delete, continue history.
- Streamed answer transport, stop, copy, retry by re-sending, helpful/unhelpful
  feedback.
- Provider status is visible; an unavailable provider is stated explicitly.
- Role-aware suggested prompts for admin, worker, collector and customer.
- Source links to the relevant BloomCore One screen.
- Clear statement that Zeli cannot post, reverse or approve money.
- Disabled-provider mode returns a plain explanation, never a fabricated answer.

## Not implemented

- Financial write actions from chat. Every financial operation stays in the
  normal authorized UI.
- Client-side Markdown/HTML rendering (plain text is intentional and safe).
- Voice, file upload and cross-device conversation export.
- DeepSeek data processing until written DPA/privacy approval and configuration.

## Role experience

| Role | Data available | Suggested focus |
|---|---|---|
| Admin | Tenant counts, today's contributions, pending withdrawals, remittance variance, daily-account status, customer search | Operations, reconciliation, exceptions |
| Worker | Own daily accounts, customer lookup | Today's account, variance explanation |
| Collector | Own assignments, today's collections/handover, customer lookup | Route and cash handover |
| Customer | Own accounts, active cycle totals | Savings and withdrawal guidance |

Zeli never expands a role's normal permissions.
