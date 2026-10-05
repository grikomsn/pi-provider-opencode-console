---
"pi-provider-opencode-console": patch
---

Serve the persisted model catalog for pi's cache-only refresh (startup, `-p` mode, and credential changes) instead of returning an empty list, which previously cleared the provider's models and left pi falling back to another configured provider. The cached catalog is also kept when a network refresh fails.
