---
"pi-provider-opencode-console": minor
---

Reduce model-catalog visibility latency so external integrators list OpenCode models immediately after startup:

- The cache-only refresh pass now publishes the persisted catalog instead of only returning it, so the model snapshot converges without waiting for network discovery.
- Go (`opencode-go-console`) discovery publishes live `/models` rows before models.dev enrichment: the first publication needs no network beyond the catalog fetch, and enrichment merges in a second pass when the ~5MB metadata payload lands (`fetchPublicModelsRows` + `buildProviderSources` + `getModelsDevSnapshot`).
- When `/models` is unreachable and nothing is persisted yet, a bundled fallback catalog of the public Go `lite` ids keeps the provider visible offline; a persisted catalog or live discovery always supersedes it.
- Both providers share one consolidated `refreshModels` publication path with tests for cache-only, network, and network-failure branches.
