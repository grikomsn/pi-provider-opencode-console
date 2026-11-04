---
"pi-provider-opencode-console": patch
---

Skip corrupt rows in pi's persisted model catalog instead of failing to load. A row with an empty or non-string `api` or `baseUrl`, a blank id, or a non-chat type is now dropped both when the catalog is seeded at registration and when it is re-served on pi's cache-only refresh, and a store that starts with a byte-order mark is read like pi reads it.
