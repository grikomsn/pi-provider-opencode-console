# Changelog

## 0.1.0

### Minor Changes

- 3175e6d: Match sibling-bridge streaming resilience: retry transient network/server failures with backoff, force-refresh the session once on 401 mid-stream, and drop rejected request options (`temperature`, reasoning/thinking) on retryable 400s. Also persist the org list across restarts so `/opencode-console switch-org` works without re-signing in.

### Patch Changes

- 20afea4: Add the `pullfrog.yml` workflow to mirror the sibling `pi-provider-poolside` setup.
- f06f76b: Open Console device sign-in at `https://opencode.ai/console/device` instead of doubling the `/console` path.

## 0.0.1

- Initial release: Pi provider for OpenCode Console via OAuth 2.0 device authorization grant.
- Discover account-specific models from the org-scoped `/api/config` endpoint.
- Route chat requests to the right upstream wire API per-model (`anthropic-messages`, `openai-completions`, `openai-responses`, `google-generative-ai`), delegating streaming and parsing to pi-ai's built-in implementations.
- Auto-refresh the OAuth access token within 5 minutes of expiry, single-flight.
- Add `/opencode-console` for `status`, `refresh`, `switch-org`, and `logout`.
- Tests, package metadata, Changesets, CI, and npm trusted publishing.
