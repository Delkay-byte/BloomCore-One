# Zeli — Test Report

**Date:** 2 November 2026

| Test | Result |
|---|---|
| Conversation ownership / cross-user denial | Pass |
| Tenant A/B grounding isolation (B customer absent from A context) | Pass |
| Admin context persists user + assistant messages and title | Pass |
| Collector receives collector context, not admin summary | Pass |
| DeepSeek disabled without approval — no fetch call, clear message | Pass |
| DeepSeek adapter with mocked response when approved | Pass |
| Server-side 40/day usage limit | Pass |
| Role suggestions/bootstrap | Implemented; server action tested through service/tests |
| Streaming transport + stop | Implemented; production build passes; browser automation not run in this pass |
| Conversation CRUD/feedback | Implemented; DB ownership checks |
| Prompt-injection text in records | Data-only context; no instruction path |

Command:

```bash
npx vitest run tests/zeli.test.ts
```
