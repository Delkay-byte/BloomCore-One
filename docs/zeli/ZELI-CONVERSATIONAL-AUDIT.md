# Zeli — Conversational Implementation Audit

**Baseline commit:** `e176307` (production)
**Audit date:** 4 November 2026
**Scope:** the request lifecycle at `/zeli` and `/api/zeli/chat`, plus the
external provider path.

This document records what the code actually did before the conversational
work, with file paths. It does not repeat the release summary.

---

## 1. Request lifecycle at baseline

| Step | What the code did | Where |
|---|---|---|
| 1. User types a message | Client textarea, 4000 character limit | `src/app/zeli/page.tsx` |
| 2. Chat request | `POST /api/zeli/chat` with `conversationId` and `message` | `src/app/zeli/page.tsx`, `src/app/api/zeli/chat/route.ts` |
| 3. Session and role | Tries `admin`, `momo`, `susu`, `customer` tenant contexts in order | `src/app/api/zeli/chat/route.ts` (`identity()`) |
| 4. Tenant context | Server-resolved `tenantId` from the session; never from the request body | `src/lib/tenant.ts`, `src/lib/zeli/types.ts` |
| 5. Intent | Keyword matching into 11 intents (no greeting, help, follow-up or clarification intent) | `src/lib/zeli/intelligence/intents.ts` (`classifyIntent`) |
| 6. Tools and records | Business admins use `buildAnalyticsSnapshot`; other roles use read-only tools | `src/lib/zeli/intelligence/responder.ts`, `src/lib/zeli/tools.ts` |
| 7. Answer generation | Deterministic template composition; `MockZeliProvider` formats tool blocks | `src/lib/zeli/intelligence/compose.ts`, `src/lib/zeli/mock-provider.ts` |
| 8. Response | The complete answer is sent once as a single-chunk stream | `src/app/api/zeli/chat/route.ts` |
| 9. Persistence | User and assistant messages, sources and `toolCalls` metadata | `src/lib/zeli/service.ts` (`runZeliTurn`) |
| 10. Usage and limits | `zeliUsage` row per user per UTC day, limit 40 | `src/lib/zeli/service.ts` (`consumeUsage`) |

## 2. What the provider layer actually was

`getZeliProvider()` returned `new MockZeliProvider()` unconditionally
(`src/lib/zeli/provider.ts`). `ZELI_PROVIDER` was not read for selection.

Consequences at baseline:

- Ordinary messages never reached DeepSeek.
- The conversational "provider" was a deterministic formatter over
  server-retrieved blocks.
- Conversation history was loaded and passed to `provider.generate()`, but
  `MockZeliProvider` ignored it. Follow-up questions were therefore not
  resolved from context.
- DeepSeek existed only as an **aggregate insight explanation** layer:
  `provider-reasoning.ts` → `insight-package.ts` → `deepseek-client.ts`, gated
  by `provider-control.ts`. It sent a fixed aggregate package, never a message.
- Every external path was hard-off: `EXTERNAL_AI_PHASE = "disabled"`,
  `PRODUCTION_PROVIDER_APPROVED = false`, emergency stop latched by default.

## 3. Baseline capability matrix

Legend: **S** supported, **P** partial, **U** unsupported.

| Capability | Baseline | Evidence |
|---|---|---|
| Greeting and introductory conversation | **U** | `classifyIntent("Hello")` → `unsupported`; `unsupportedAnswer()` returned the limitation list |
| General business questions | **S** | `answerAdminBusinessQuestion` → `buildAnalyticsSnapshot` → `composeOverview` |
| Contributions and withdrawals | **S** | intent `contributions_withdrawals` → `composeContributions` |
| Income and expenses | **U** | no intent and no composer; only the overview mentioned expenses |
| Remittances and variances | **S** | intent `remittances` → `composeRemittances` |
| Branch comparisons | **S** | intent `branches` → `composeBranches` |
| Period comparisons | **S** | `detectPeriod` presets and `composeOverview` comparison block |
| Follow-up questions | **U** | history ignored; `"And last month?"` → `unsupported` |
| Contextual conversation | **U** | no stored turn context was read back |
| Explanation of calculated figures | **S** | `statement()` kinds (`CALCULATED FACT`, `DETECTED PATTERN`, …), `explainMetricDefinition` |
| Unsupported or ambiguous questions | **P** | unsupported had an honest message; ambiguity produced the same generic message, not a clarifying question |
| Role-aware assistance | **S** | `isSupportedForRole`, tool permissions, `buildZeliContext` |
| General knowledge conversation | **U** | `unsupported`; no external conversational path existed |

## 4. Gaps against the intended product

1. No social layer: greeting, help, identity, thanks and small talk were all
   "unsupported".
2. No conversational memory: follow-up questions could not inherit subject or
   period.
3. No clarification flow: ambiguous requests received a dead-end limitation.
4. No income/expenses intent.
5. No external conversational provider: DeepSeek's role was aggregate
   explanation only, and no module could send a user message.
6. No mode distinction in the response or UI beyond the external-AI banner.
7. No explicit refusal path for financial instructions: an instruction such as
   "approve the pending withdrawal" could be answered as a withdrawal summary.

## 5. What this change adds

| Capability | After | Code | Test |
|---|---|---|---|
| Greeting and introduction | **S** (local) | `conversation/acts.ts`, `conversation/social.ts` | `zeli-conversation.test.ts` → "greets the user without calling any provider" |
| Help and capability listing | **S** (local) | `social.ts` (`help`) | "explains its capabilities on request" |
| Identity and honesty about the engine | **S** (local) | `social.ts` (`identity`) | "answers identity questions honestly" |
| General business questions | **S** | unchanged responder | existing `zeli.test.ts` |
| Contributions and withdrawals | **S** | unchanged | existing |
| Income and expenses | **S** (new) | `intents.ts` (`income_expenses`), `compose.ts` (`incomeAndExpenses`) | `zeli-intents.test.ts`, `zeli-conversation.test.ts` |
| Remittances and variances | **S** | unchanged | existing |
| Branch comparisons | **S** | unchanged | existing |
| Period comparisons | **S** | unchanged | existing |
| Follow-up questions | **S** | `conversation/context.ts` | "resolves a period-only follow-up…", "resolves a why follow-up…" |
| Contextual conversation | **S** within one conversation | `context.ts` reads the last assistant turn's stored context | "persists history with intent, period and mode metadata" |
| Explanation of calculated figures | **S** | unchanged composers | existing |
| Ambiguous questions | **S** | `conversation/clarify.ts` + `clarificationAnswer` | "asks one clarifying question and completes it on the next turn" |
| Unsupported questions | **S** | `unsupportedAnswer` | "explains an unsupported question instead of inventing an answer" |
| Role-aware assistance | **S** | `isSupportedForRole`, tool permissions | "keeps worker and collector questions inside their role" |
| Financial instruction refusal | **S** (new) | `acts.ts` (`isFinancialInstruction`) | "refuses financial instructions and confirms nothing changed" |
| Tenant isolation | **S** | `assertConversationOwner` | "does not leak another tenant's records through a follow-up" |
| General knowledge conversation | **U locally; gated externally** | `social.ts` + `providers/*` | "gives a useful local explanation…"; external tests in `zeli-deepseek-conversation.test.ts` |

## 6. Honest limitations after this change

- Contextual memory is bounded to the previous assistant turn and a pending
  clarification. It is not long-range memory.
- Intent recognition is deterministic keyword matching, not learned language
  understanding. Unusual phrasing can still be unsupported.
- The external conversational mode is implemented and gated, but **not
  enabled in production**. Production Zeli is local.
- External conversational answers are limited to non-financial conversation.
  Business figures are always answered locally.
- The local engine never claims to be an LLM.
