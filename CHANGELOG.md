# Changelog

## 1.0.1

### Patch Changes

- f5f2c15: Send the `x-opencode-session` header the Go surface requires, and use the raw upstream model id instead of the duplicate-disambiguated pi id, so console-catalog models such as `opencode-go/deepseek-v4.1-flash` no longer fail with `MissingSessionID` or `Model is unavailable`.

## 1.0.0

### Major Changes

- 321d00c: Align auth with OpenCode's current two-auth-system model (Console + Go, with Zen merged into Console):

  - Add service-key auth (workspace `sk-` API keys) for both providers via pi's standard `auth.json` entries — store `{ "opencode-console": { "type": "api_key", "key": "sk-…" } }` or the same under the new `opencode-go-console` id. A stored credential owns the provider; pi's `/login` also gains an "Enter API key" prompt, and the `$OPENCODE_API_KEY` env template covers the nothing-stored fallback (matching upstream's own env convention).
  - Add a Go-mode provider `opencode-go-console` ("OpenCode Go") mirroring the sister bridge: device-code sign-in reuses the shared Console device flow, model discovery always loads the public Go gateway catalog (`https://opencode.ai/zen/go/v1/models`, the auth-ignored `lite` list), and requests target the Go gateway with `Authorization: Bearer` (service key or Console access token) plus the org id headers for session credentials. `opencode-go` stays free of collisions with pi's built-in provider of the same name.
  - Console keeps its org-scoped `/api/config` catalog for device sessions and switches to the shared public `/models` catalog (`https://opencode.ai/zen/v1`) when a service key is stored; public rows are enriched from models.dev (`opencode` / `opencode-go` provider entries), dropping disabled/deprecated ids.
  - The single canonical refresh path rotates the shared Console session once (freshest entry first, with a sibling-entry fallback when a lineage's refresh token has gone dead) and mirrors rotated token fields into the sibling provider's oauth entry, so both stay valid under refresh-token rotation while each entry keeps its own org choice. Go sign-out preserves the Console session; a 401 on a service key is terminal (keys don't rotate).
  - `/opencode-console` and `/opencode-go-console` manage both credential types (`status`, `refresh`, `logout`, Console `switch-org`); also fixed the `switch-org` subcommand alias that previously fell through to `status`, and the first streaming request now loads the stored credential before sending (previously it relied solely on a 401-triggered refresh).

### Patch Changes

- 321d00c: Port the sister bridge's catalog fixes and metadata parity ahead of the v1.0.0 bump:

  - Route model families the way the gateways actually behave even when models.dev omits a package name: Grok and Muse Spark ids route to Responses, Qwen ids to Messages, Go MiniMax ids to Messages, and Console Gemini ids to Google.
  - Filter internal `test*` smoke-test ids that leak into authenticated discovery instead of listing them as unenriched entries.
  - Enrich discovery-only ids that models.dev has not cataloged yet with mirrored sibling metadata (Console: `jev-1.13`, `jev-1.13-free`; Go: `deepseek-flash`, `minimax-m2.5`, `kimi-k2.5`, `glm-5.1`, `glm-5`, `qwen3.5-plus`, `mimo-v2-pro`, `mimo-v2-omni`, `omen-alpha`, `hy3-preview`); canonical upstream entries supersede the mirrors automatically once they land.
  - Hide the legacy alias id (`deepseek-flash` → `deepseek-v4.1-flash`) when both are served in one discovery response; alias-only discovery keeps its mirrored metadata.
  - Map `reasoning_options` effort values onto pi's thinking levels (unsupported levels are explicitly `null` so pi's clamping picks a supported effort instead of sending one the gateway rejects); toggle/budget-only models are unmapped.
  - Cache the models.dev snapshot in-process with a 6h TTL and a 15s timeout instead of refetching the full catalog on every model refresh, keeping provider-level `npm` routing inheritance.

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
