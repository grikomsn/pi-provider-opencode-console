<p align="center">
  <img src="assets/cover.jpg" alt="OpenCode Console provider for Pi" width="800">
</p>

# pi-provider-opencode-console

[![npm](https://img.shields.io/npm/v/pi-provider-opencode-console)](https://www.npmjs.com/package/pi-provider-opencode-console)
[![CI](https://github.com/grikomsn/pi-provider-opencode-console/actions/workflows/ci.yml/badge.svg)](https://github.com/grikomsn/pi-provider-opencode-console/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A [Pi](https://github.com/earendil-works/pi-coding-agent) provider for [OpenCode Console](https://opencode.ai/console) that signs in via the OAuth 2.0 device authorization grant and discovers account-specific models from the org-scoped `/api/config` endpoint.

## Features

- OAuth 2.0 device authorization grant (RFC 8628) sign-in via `/login opencode-console`
- Per-org model discovery from the org-scoped `GET /api/config` endpoint
- Routes chat requests to the right upstream wire API per-model (`anthropic-messages`, `openai-completions`, `openai-responses`, `google-generative-ai`)
- Delegates streaming and parsing to pi-ai's built-in implementations
- Auto-refreshes the OAuth access token within 5 minutes of expiry, single-flight
- Org selection at sign-in and via `/opencode-console switch-org`
- Adds `/opencode-console` for `status`, `refresh`, `switch-org`, and `logout`
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

1. Sign in with the device-code flow:

   ```
   /login opencode-console
   ```

   Pi prints a user code and the verification URL. Approve the sign-in in your browser.

2. If your account has multiple orgs, Pi prompts you to pick one. The choice is persisted to `auth.json`.

3. Pick a model with `/model`. OpenCode Console-published models appear alongside built-ins.

4. Run the `/opencode-console` subcommand to manage the session:

   ```
   /opencode-console status       # default; shows account, org, token expiry
   /opencode-console refresh      # re-pull /api/config
   /opencode-console switch-org   # re-pick the org
   /opencode-console logout       # clear auth.json
   ```

OAuth credentials live in `~/.pi/agent/auth.json` (managed by Pi; `/logout opencode-console` clears them).

## Configuration

| Env var | Default | Notes |
| --- | --- | --- |
| `OPENCODE_CONSOLE_SERVER` | `https://opencode.ai/console` | Override for self-hosted consoles. Persisted to `auth.json` on first sign-in. |

## Why a separate provider?

The built-in `opencode` and `opencode-go` providers in Pi handle API-key-only Zen/Go access. Console is different — it uses OAuth device flow and proxies an org-scoped model catalog. This extension keeps those flows isolated, so the built-in providers keep their static model lists and API-key UX.

## Architecture

```
pi extension entry (src/index.ts)
  └─ registerProvider("opencode-console", { oauth, refreshModels, streamSimple })
       ├─ oauth.login      → device-code flow + org picker → auth.json
       ├─ refreshModels    → /api/config → ProviderModelConfig[]
       └─ streamSimple     → streamConsoleWithSession
            └─ streamConsole → delegates to pi-ai's lazy APIs
                 ├─ anthropicMessagesApi
                 ├─ openAICompletionsApi
                 ├─ openAIResponsesApi
                 └─ googleGenerativeAIApi
```

URL routing is normalized per API kind in `src/endpoint.ts` so each SDK's URL composition produces the right endpoint:

| API kind | baseUrl normalization |
| --- | --- |
| `anthropic-messages` | strip trailing `/v1` (Anthropic SDK appends `/v1/messages`) |
| `openai-completions` | keep `/v1` (SDK appends `/chat/completions`) |
| `openai-responses` | keep `/v1` (SDK appends `/responses`) |
| `google-generative-ai` | keep `/v1beta` (Google SDK appends `/models/<id>:streamGenerateContent`) |

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
