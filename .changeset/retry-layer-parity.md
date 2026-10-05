---
"pi-provider-opencode-console": patch
---

Retry-layer parity with the sister bridge, verified by a full source diff: transient-retry 500 responses carrying a bare "Internal server error." body (pi-ai formats them with a leading status, so the match is allowed there too); patch 400 context-overflow responses by shrinking the completion budget and retrying (`maximum context length is X … you requested Y … Z in the completion` — pi's token estimates are heuristic and can undercount long transcripts, and the reduction respects whichever token field the API variant sends); and a fresh `x-opencode-request` tracing id per request attempt instead of one reused from the session load.