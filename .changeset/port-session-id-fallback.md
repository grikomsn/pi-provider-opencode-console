---
"pi-provider-opencode-console": patch
---

Fall back to a deterministic per-conversation session id when the caller supplies no `options.sessionId`: hash the wire model id plus the first two transcript messages (FNV-1a, prefixed `pi-`) and send it as the gateway's required `x-opencode-session` routing header, mirroring the sister bridge's proven-in-marketplace approach. Explicit caller session ids still win, and pre-existing header overrides are still respected, but Go-surface chats no longer depend on runtime session plumbing for their routing key.
