# Zeli — Security and Privacy

## Authorization

- Identity is resolved from the session (`admin`/`momo`/`susu`/`customer`).
- Conversation reads/writes require exact `tenantId + userId` ownership.
- Every tool has a role allow-list and is tenant-scoped in SQL.
- The model never chooses tenant, user, provider or permissions.
- No arbitrary SQL, code, shell or outbound HTTP exists in a tool.

## Financial actions

Zeli is read-only in this release. It cannot post, reverse, approve, change
ownership or alter security settings. Answers state this and link to the normal
screen. Any future write tool must produce a proposal, require the normal
confirmation UI, reauthorize server-side and call the existing domain service.

## Prompt injection

- Retrieved database values are serialized as data blocks.
- The system prompt explicitly marks context as untrusted and non-instructional.
- No Markdown/HTML is rendered from model output; text is shown verbatim.
- Tool execution is allow-listed before the provider call and never driven by
  content.

## Data minimisation and logs

- Only counts, identifiers and monetary summaries needed for the answer are
  retrieved; full records are not sent when a summary suffices.
- Prompts and answers are not written to application logs.
- Provider errors are normalized; secrets never appear in responses.
- Conversation deletion removes messages by cascade.

## Usage and abuse

- 40 requests/user/day, enforced in the database.
- 30 conversations/user limit.
- 4,000-character message limit.
- Provider timeout 30 seconds.
- Same-origin check on the chat route.
- No external provider is called unless explicitly approved and configured.

## Residual risk

- A compromised browser session can read that user's conversations.
- Database superusers can read conversation text; it is not encrypted at rest.
- Mock mode is deterministic and does not provide general language reasoning.
