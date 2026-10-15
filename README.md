<p align="center">
  <img src="assets/cover.jpg" alt="OpenCode Console provider for Pi" width="800">
</p>

# pi-provider-opencode-console

[![npm](https://img.shields.io/npm/v/pi-provider-opencode-console)](https://www.npmjs.com/package/pi-provider-opencode-console)
[![CI](https://github.com/grikomsn/pi-provider-opencode-console/actions/workflows/ci.yml/badge.svg)](https://github.com/grikomsn/pi-provider-opencode-console/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A [Pi](https://github.com/earendil-works/pi-coding-agent) provider for [OpenCode Console](https://opencode.ai/console) that signs in via the OAuth 2.0 device authorization grant and discovers account-specific models from the org-scoped `/api/config` endpoint. Ships two providers mirroring OpenCode's two auth systems: **OpenCode Console** (`opencode-console`) and **OpenCode Go** (`opencode-go-console`) — both sign in exclusively via device-code (OAuth).

> **Breaking change in 2.0:** the `sk-` service-key (API-key) auth method was removed. See [Authenticate](#authenticate) for the migration note.

## Features

- OAuth 2.0 device authorization grant (RFC 8628) sign-in via `/login opencode-console` (and `/login opencode-go-console` — Go reuses the shared Console device flow); pi's `/login` lists both providers as "…(OAuth device code)", distinct from pi's native API-key option
- Org-scoped sign-in: the device grant requests organization scoping, so the workspace is chosen during browser approval when the Console grants it; otherwise a single-org account self-selects and multi-org accounts pick explicitly after sign-in
- Console: per-org model discovery from the org-scoped `GET /api/config` endpoint
- Go: the public `GET https://opencode.ai/zen/go/v1/models` catalog (the auth-ignored `lite` list), requests targeting the Go gateway
- Public catalog rows are enriched from models.dev and drop disabled/deprecated ids
- Routes chat requests to the right upstream wire API per-model (`anthropic-messages`, `openai-completions`, `openai-responses`, `google-generative-ai`)
- Delegates streaming and parsing to pi-ai's built-in implementations
- Auto-refreshes the OAuth access token within 5 minutes of expiry, single-flight, with rotated tokens mirrored across both provider entries (shared device-flow session)
- Org selection at sign-in and via `/opencode-console switch-org`
- Adds `/opencode-console` and `/opencode-go-console` for `status`, `refresh`, `logout` (Console also `switch-org`)
- Optional `OPENCODE_CONSOLE_SERVER` override for self-hosted consoles

## Install

```sh
pi install npm:pi-provider-opencode-console
```

To try a local checkout:

```sh
pi -e ./src/index.ts
```

## Authenticate

OpenCode has two auth systems — **Console** (which absorbed Zen) and **Go** (the subscription gateway). Both providers here sign in with an OAuth device-code session on the shared Console device flow; pi stores exactly one credential per provider id in `~/.pi/agent/auth.json`, so the stored oauth credential owns the provider.

> **Note:** this extension is OAuth-only by design. pi's generic "Enter API key" login is not offered for these providers — if you want plain API-key access with a static model list, use pi's built-in `opencode` / `opencode-go` providers instead.

> **Migrating from service keys (pre-2.0):** service-key auth was removed in 2.0. Any `{ "type": "api_key", "key": "sk-…" }` entries for `opencode-console` / `opencode-go-console` in `~/.pi/agent/auth.json` are now inert (pi reports "Provider is not configured"). Delete those entries and run the device-code sign-in below.

### Device-code (OAuth) sign-in

```
/login opencode-console
# …or, for the Go gateway:
/login opencode-go-console
```

Pi prints a user code and the verification URL. Approve the sign-in in your browser — if the Console grants an org-scoped session, the organization is the one you pick during browser approval (pi shows it as "server-scoped at sign-in"). Un-scoped single-org accounts self-select; multi-org accounts are prompted to pick one (persisted to `auth.json`). Go orgs are the Console org — the session is shared. A server-scoped session cannot switch organizations locally; sign in again to choose a different one.

Model catalogs by provider:

| Provider | Catalog |
| --- | --- |
| `opencode-console` | org-scoped `GET {server}/api/config` with `Authorization: Bearer` + `x-org-id` |
| `opencode-go-console` | public `GET https://opencode.ai/zen/go/v1/models` (`lite` list), called with the session's access token |

### Manage

Run the provider commands to manage credentials:

```
/opencode-console status       # default; shows auth method (device-code OAuth session), account, org, token expiry
/opencode-console refresh      # re-pull the org-scoped catalog
/opencode-console switch-org   # un-scoped sessions only; re-pick the org (scoped sessions: sign in again)
/opencode-console logout       # clear the credential

/opencode-go-console status    # auth method + account + org
/opencode-go-console refresh   # re-pull the public Go catalog
/opencode-go-console logout    # clear the Go credential; Console session preserved
```

## Configuration

| Env var | Default | Notes |
| --- | --- | --- |
| `OPENCODE_CONSOLE_SERVER` | `https://opencode.ai/console` | Override for self-hosted consoles. Persisted to `auth.json` on first sign-in. |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi's agent directory, also used by this extension for session storage. Set it to an isolated directory for testing. |

## Why separate providers?

The built-in `opencode` and `opencode-go` providers in Pi handle API-key-only access with static model lists. This extension deliberately registers distinct ids (`opencode-console`, `opencode-go-console`) so the built-ins stay untouched, while adding the OAuth device-code session, live catalogs, and org awareness that the built-ins do not have — mirroring the behavior of the sister project (`opencode-copilot-chat`).

## Architecture

```
pi extension entry (src/index.ts)
  ├─ registerProvider("opencode-console", { oauth, refreshModels, streamSimple })   [OAuth-only: no apiKey method]
  │    ├─ oauth.login      → shared device-code flow + org picker → auth.json[providerId]
  │    ├─ oauth.refreshToken → canonical refresh + sibling mirror (shared session)
  │    ├─ refreshModels    → org-scoped /api/config
  │    └─ streamSimple     → streamConsoleWithSession (session loader)
  ├─ registerProvider("opencode-go-console", { oauth, refreshModels, streamSimple }) [OAuth-only]
  │    ├─ refreshModels    → public /models on the Go gateway (lite list, session token)
  │    └─ streamSimple     → streamConsoleWithSession (Go entry, Console-entry fallback)
  └─ registerCommand for both providers
       streamConsole → delegates to pi-ai's lazy APIs
            ├─ anthropicMessagesApi
            ├─ openAICompletionsApi
            ├─ openAIResponsesApi
            └─ googleGenerativeAIApi
```

Upstream parity research and adopted-behavior citations live in [`docs/opencode-auth-parity.md`](docs/opencode-auth-parity.md).

URL routing is normalized per API kind in `src/endpoint.ts` so each SDK's URL composition produces the right endpoint:

Generic OpenCode catalog bases (`/zen/v1`, `/zen/go/v1`, `/inference/v1`, and
`/inference/go/v1`) resolve to canonical protocol-specific inference bases before
SDK URL composition. Gemini models on both gateways use Google, including Go's
`gemini-4-argon-contributor`; the legacy Go gateway has no Google route. Model-level
SDK metadata takes precedence over family fallbacks, and custom endpoints remain
available through model/provider overrides.

| API kind | baseUrl normalization |
| --- | --- |
| `anthropic-messages` | `/inference[/go]/anthropic`, stripping trailing `/v1` for the SDK's `/v1/messages` |
| `openai-completions` | `/inference[/go]/openai/v1` (SDK appends `/chat/completions`) |
| `openai-responses` | `/inference[/go]/openai/v1` (SDK appends `/responses`) |
| `google-generative-ai` | `/inference[/go]/google/v1beta` (SDK appends `/models/<id>:streamGenerateContent`) |

Identity headers (`x-opencode-org-id`, `x-opencode-client`, `x-opencode-request`) are injected per request in `streamConsole`.

## Development

```sh
npm install
npm run check
npm run package
```

## Project

- [Changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Release process](RELEASING.md)

## License

MIT
