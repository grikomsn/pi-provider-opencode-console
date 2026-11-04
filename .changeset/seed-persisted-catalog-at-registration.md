---
"pi-provider-opencode-console": patch
---

Seed each provider with pi's persisted catalog at registration time.

pi publishes a discovered catalog to `models-store.json` and re-serves it on an
asynchronous cache-only refresh, so a provider registered with `models: []` is
empty until that pass lands. pi resolves its startup model
(`defaultProvider`/`defaultModel`) before then: the lookup misses, and pi falls
back to another configured provider's default (e.g. `deepseek-v4-pro` when
`DEEPSEEK_API_KEY` is set). A saved default was therefore honoured only when the
refresh happened to win the race — roughly half of all launches, and the
session then stayed on the wrong model until `/model` was applied manually.

Both providers now register the catalog pi persisted for them, so the saved
default resolves immediately. `refreshModels` stays authoritative and still
replaces the seed on the first network pass.
