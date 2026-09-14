---
"pi-provider-opencode-console": minor
---

Match sibling-bridge streaming resilience: retry transient network/server failures with backoff, force-refresh the session once on 401 mid-stream, and drop rejected request options (`temperature`, reasoning/thinking) on retryable 400s. Also persist the org list across restarts so `/opencode-console switch-org` works without re-signing in.