---
"pi-provider-opencode-console": major
---

**Org-scoped Console device sign-in** (parity with opencode-copilot-chat #66 and the tanstack adapter):

- The device authorization request opts in to organization scoping (`supports_org_scope: true`). When the Console grants a scoped session, the organization is the one chosen during browser approval (`org_id` at token exchange, persisted as `OPENCODE_CONSOLE_SCOPED_ORG_ID` and honored across refreshes — a refresh that changes the scope is a hard error).
- Un-scoped single-org accounts self-select; multi-org accounts pick explicitly after sign-in (no silent first-org auto-select).
- `/opencode-console switch-org` is rejected for server-scoped sessions ("sign in again to switch"); status output marks scoped sessions.

**Fixed streaming for non-OpenAI-routed models:** catalog models now carry the extension-level `api` with the real gateway route in `wireApi`, so every model goes through this extension's stream wrapper. Previously anthropic/google-routed models bypassed it and failed with 404 (doubled `/v1` on the wire: `…/inference/anthropic/v1/v1/messages`).
