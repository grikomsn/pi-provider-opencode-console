# OpenCode auth parity research — pi-provider-opencode-console

> **2026 update (2.0):** the service-key (API-key) method described below was
> **removed**. Both providers are now OAuth-only (device code). The research
> below is retained as a historical record; sections A3/A5 and the "Adopted
> design" items about `apiKey` registration, `$OPENCODE_API_KEY`, and
> service-key catalog/command paths no longer apply. See
> [`api-key-removal-plan.md`](api-key-removal-plan.md) for the removal inventory.

Task-1 findings for goal `muumr2dy-0dzpb4`. Sources:
- **[upstream]** https://github.com/anomalyco/opencode/ (shallow clone retained at `/tmp/opencode-upstream`) — scout `upstream-scout` (run 18624155-5bd2-488c-9482-3df9dc6a0694).
- **[sister]** `~/Workspace/grikomsn/opencode-copilot-chat` (read-only recon) — scout `sister-scout` (run b5fc1920-5db1-4682-abef-10153f9dacc8).
- **[pi]** vendored runtime in `node_modules/@earendil-works/pi-{coding-agent,ai}` — read by the main agent.

## A. Pi runtime integration facts (complete)

### A1. auth.json credential shapes (`pi-coding-agent/dist/core/auth-storage.js`)
- One type-tagged credential per provider id; entries validated at load (`ReadOnlyAuthStorage.load()`, auth-storage.js:181-208):
  - `type:"api_key"`: `{ key?: string, env?: Record<string,string> }` — `key` may be a config-value template (`"$OPENCODE_API_KEY"` env ref, `!cmd` command, literal), resolved at read time (auth-storage.js:213-216).
  - `type:"oauth"`: requires `{ access: string, refresh: string, expires: number }`; arbitrary extra fields allowed (our `env` block) (auth-storage.js:198-205).
- Writes go through a serialized `modify()` (proper-lockfile) — the runtime is the write authority after login.

### A2. Auth resolution per credential type (`pi-ai/dist/auth/resolve.js`)
- `resolveProviderAuth` (resolve.js:40-61): stored credential owns the provider; ambient env consulted only when nothing stored.
- `stored.type === "oauth"` resolves only if `provider.auth.oauth` exists; **`stored.type === "api_key"` resolves only if `provider.auth.apiKey` exists**; otherwise auth resolution returns undefined → "Provider is not configured".
- ⇒ **A stored `{type:"api_key"}` credential is unusable with our current oauth-only registration.**

### A3. Extension provider composition (`pi-coding-agent/dist/core/provider-composer.js`)
- `composeApiKeyAuth` (provider-composer.js:145-205): for a pure extension provider (no built-in base) with `extension.apiKey` undefined and oauth present → returns `undefined` ("OAuth-only providers get no fabricated API-key login method", :150-151). ⇒ **The registration must supply `apiKey`** (template string, e.g. `"$OPENCODE_API_KEY"`) so the api_key path exists.
- With `auth.apiKey` registered:
  - Stored credential resolves without env: `input.credential.key → { auth: { apiKey: key } }` (:188-191). Bearer header added by `withConfiguredAuth` (:155-162).
  - Ambient fallback resolves the env template only when nothing stored (:175-178, 205-211).
  - pi's `/login` gains a native "Enter API key" path via the default `login` prompt (:153-156).
- `composeOAuthAuth` wraps extension oauth unchanged (login/refreshToken/getApiKey hooks; `modifyModels(models, credential)` hook available + used during refresh, :253-271).
- `refreshModels` is called with `{ credential, stored, publish, allowNetwork, force, signal }` — **`credential` is the stored (oauth or api_key) credential** (`pi-ai/dist/models.js:126-133`). so catalog loading can branch on `context.credential?.type`.
- `streamSimple`/`stream` receive runtime-prepared options (`model-runtime.js prepareRequest`: `options.apiKey = resolution.auth.apiKey`; oauth → `getApiKey(credentials)` = access token; api_key → stored key). Our extension's streamSimple currently ignores that and self-loads the session from auth.json.

### A4. Built-in provider id landscape (`pi-ai/dist/models.generated.js:67-68`, `env-api-keys.js:101-102`)
- Built-ins include `opencode` and `opencode-go`, both keyed to env `OPENCODE_API_KEY` (+ separate `ln`, `ln-go` pairs).
- Registering an extension under a built-in id MERGES with the built-in (composed as `base` + `extension`). Registering a NEW id composes with only models.json config.
- **Decision: register the Go-mode provider as `opencode-go-console`** — sibling of `opencode-console`, zero collision with built-in `opencode-go`, preserves the README's "keep our flows isolated from built-ins" principle; built-in static model lists stay untouched. Display name: "OpenCode Go".

### A5. Service-key entry UX (per user decision: standard auth.json only)
- Documented manual shape (one credential per provider id — storing a service key replaces any oauth entry in that slot):
  ```json
  { "opencode-console": { "type": "api_key", "key": "sk-…" } }
  { "opencode-go-console": { "type": "api_key", "key": "sk-…" } }
  ```
- pi's own login flow additionally offers "Enter API key" once `auth.apiKey` is registered — no custom prompt code needed.

## B. Upstream opencode findings (scout: `/tmp/opencode-upstream` @ anomalyco/opencode HEAD)

### B1. Device flow — unchanged shapes; our implementation stays valid
- Core plugin: `packages/core/src/plugin/provider/opencode.ts:16` server `https://opencode.ai/console`; :20 `client_id = "opencode-cli"`; :47 POST `${server}/auth/device/code` `{client_id}`; :69-73 refresh POST `${server}/auth/device/token` `{grant_type:"refresh_token", refresh_token, client_id, client_id}`; :249-262 polling `{grant_type:"urn:ietf:params:oauth:grant-type:device_code", device_code, client_id}`.
- Response schema (:21-27) `{device_code, user_code, verification_uri_complete, expires_in, interval}` — same as ours; pending/error via `{error}` union (:29-31) with `authorization_pending`/`slow_down`(+5s) handling (:259-266).
- Account module: `packages/opencode/src/account/account.ts:392` (device/code), :419-425 (poll), success carries `token_type:"Bearer"` (:101); richer error map :112-122 (`authorization_pending|slow_down|expired_token|access_denied`).
- Δ: `/code` unchanged; `/token` success also carries `refresh_token` always + `token_type`, `error_description` — none breaking.

### B2. Service keys = workspace API keys, format `sk-…`
- Label: `"API key (service account)"` — `packages/core/src/plugin/provider/opencode.ts:106`. Console UI/docs say plain "API key" (`packages/web/src/content/docs/go.mdx:33`, `zen.mdx`).
- Generation: `"sk-" + 64 alnum` — `packages/console/core/src/key.ts:50-60`. **One key family for console AND go; no separate go prefix.**
- Upstream auth storage (`~/.local/share/opencode/auth.json`, `packages/opencode/src/auth/index.ts:6-28`): `{type:"oauth", refresh, access, expires, accountId?, enterpriseUrl?}` (:10-16) or `{type:"api", key, metadata?}` (:18-21); single entry per providerID, last login wins (`packages/opencode/src/cli/cmd/providers.ts:28-31,118-130`).

### B3. Credential precedence
- Most-recent-credential wins; no explicit key-over-session preference (`packages/core/src/integration.ts:288-298,382-383`; `opencode.ts:201-203`). In pi's one-credential-per-id model the stored entry type IS the effective method — matches.

### B4. Catalog endpoints per credential type
- Org-scoped: `GET {consoleServer}/api/config`, headers `Authorization: Bearer <access-or-key>` + `x-org-id` when present; 404 tolerated (`opencode.ts:198-210`; `account.ts:370-375`; user/orgs at :293-296/:300).
- Public console: `GET https://opencode.ai/zen/v1/models` — public without key; workspace-disabled models filtered only with a real key (`packages/console/app/src/routes/zen/v1/models.ts:14-30`).
- Public go: `GET https://opencode.ai/zen/go/v1/models` — auth-ignored, `lite` model list (`packages/console/app/src/routes/zen/go/v1/models.ts:9-12`).

### B5. Go gateway
- Base `https://opencode.ai/zen/go/v1` (`packages/console/app/src/routes/zen/go/v1/{responses,chat,messages,*}.ts`; docs `go.mdx:401-430`).
- Chat auth: `/responses` + `/chat` → `Authorization: Bearer` (`zen/go/v1/responses.ts:10`); Anthropic-style `/messages` → `x-api-key` (`zen/go/v1/messages.ts:8`).
- Go is linked to the console account via the same workspace `sk-` keys + console billing ("Go subscriptions have moved to the new Console", `packages/console/core/src/billing.ts:307`).

### B6. zen→console merge
- Wire surfaces unchanged (console server, device endpoints, zen gateway paths); client labels now "OpenCode Console account" (`opencode.ts:55`), method "API key (service account)" (:106).
- Go plan = `lite` limits (`packages/console/core/src/subscription.ts:10-16`, `Resource.ZEN_LIMITS` free/lite/black).
- x-org-id is asserted only on `/api/config` + console API calls, not gateway traffic (`packages/opencode/src/share/share-next.ts:214-218`) — gateway tolerates extra org headers.
- ⚠ Upstream client models use env `OPENCODE_API_KEY` (docs `zen.mdx:171-172`) — the same var pi built-ins use.

## C. Sister project findings (`~/Workspace/grikomsn/opencode-copilot-chat`)

### C1. Constants + header mapping (`src/transport/protocol.ts`)
- :1-6 `DEFAULT_CONSOLE_SERVER=https://opencode.ai/console`, `CONSOLE_API_BASE_URL=https://opencode.ai/zen/v1`, `GO_API_BASE_URL=https://opencode.ai/zen/go/v1`, `OPENCODE_CLIENT_ID="opencode-cli"`.
- :33-42 `apiBaseForMode`; `buildAuthHeaders`: messages→`x-api-key`+anthropic-version, google→`x-goog-api-key`, else `Authorization: Bearer` (same as our `src/endpoint.ts routeFor`).
- :110-116 `endpointUrl`: `<base>/messages`, `<base>/responses`, `<base>/chat/completions`.
- :65-103 `resolveEndpointKind` — like our `resolveRoute` + mode-dependent extras (`minimax-*` go→messages; `gemini-*` console→google; `qwen*`→messages).

### C2. Catalog per credential (`src/models/catalog.ts`)
- Dispatch :72-74 + `credentialIsApiKey` :172-175 (`!credential.server`): console+session → org-scoped `${server}/api/config` (Bearer + `x-org-id`, :145-156, uses only `providers.opencode`; other provider groups excluded because "Go has its own provider group and public discovery"); everything else → public `${apiBaseForMode(mode)}/models` (:126-133), `Authorization: Bearer <token>` when token present (service key or console access token).
- Public path merges models.dev snapshot (providerId `opencode`/`opencode-go`) with live /models rows and dedups alias models (:112-124); filters `deprecated`/`disabled`/internal ids (:184-188). Org-scoped errors clear the list (never show another org's models) (:82-91).

### C3. Go-mode semantics
- `src/auth/auth.ts` getCredential comment: "device sign-in for either mode stores a shared Console session" — one SessionKey per profile; go reuses it; go requests send Bearer(service key) or Bearer(console access token) + `x-org-id` when the session carries an org (`src/provider.ts:172-174`).
- Go NEVER loads org-scoped `/api/config` (catalog.ts:73-74); catalog always public go /models.
- Shared device flow constants identical to ours (auth.ts:118,130-137).

### C4. Legacy zen migration + precedence/sigout (`src/auth/auth.ts`, `src/commands/commands.ts:387-390`)
- API-key blob `{zen, go}` → rewritten `{console, go}` when `zen` non-empty and `console` absent (auth.ts:84-110).
- `defaultMode: "zen"` → normalized to console in-place mapping (not rewritten unless user updates the setting).
- Precedence: api key wins over session unless forceRefresh (auth.ts:150-168). Sign-out: always clears the mode's api key; console also clears the device session; go sign-out preserves the shared session (auth.ts:241-251).

## D. Adopted design for this repo (decisions)

1. **Provider ids**: keep `opencode-console`; add **`opencode-go-console`** (non-colliding; avoids merging with pi built-in `opencode-go`).
2. **Service keys**: standard pi `type:"api_key"` entries; both registrations get `apiKey: "$OPENCODE_API_KEY"` so stored credentials resolve (+ambient env aligned with upstream/pi built-ins; env consulted only when nothing stored). One slot per provider id — setting a service key replaces the oauth entry in that slot.
3. **Catalog branching** (in `refreshModels({credential})`):
   - `opencode-console`: `oauth` → org-scoped `{session.server}/api/config` + `x-org-id` (current behavior); `api_key` → public `https://opencode.ai/zen/v1/models` with `Authorization: Bearer <key>`.
   - `opencode-go-console`: **always** public `https://opencode.ai/zen/go/v1/models` (Bearer with key/access token when present).
   - Public rows projected the same way as /api/config rows (`buildPiModels`); enrichment from models.dev `api.json`, providerId `opencode`/`opencode-go` (sister pattern, metadata.ts:3 `MODELS_DEV_API_URL`), filtered `deprecated`/`disabled`.
4. **Streaming**: same gateway routing as today (`endpoint.ts`); token = `options.apiKey` (service key or access token). Session-mode keeps 401 refresh + `x-opencode-org-id`; api_key mode skips refresh (a dead key is terminal) and omits org headers (only /api/config uses x-org-id upstream; gateway tolerates extra org headers but only sessions have orgs).
5. **Go device login** shares the console device flow (`opencode-cli`); on login, store the session in the `opencode-go-console` oauth entry (with its own org pick); refresh hooks single-flight, try freshest-lineage-first with a sibling fallback, and mirror rotating token fields (tokens only, `env` preserved per provider) across oauth entries to survive refresh-token rotation; go sign-out preserves the console session (sister semantics).
6. **Commands**: `/opencode-console` (status/refresh/switch-org/logout — status shows credential kind; org ops rejected for service keys), new `/opencode-go-console` (status/refresh/logout; logout preserves console session).
7. **Naming**: user-facing language per upstream = "API key (service account)"; wire term stays "service key" in docs where convenient.

## E. Residual risks / open questions
- Console gateway accepting console **access tokens** on go gateway endpoints is inferred from the sister project's shipped behavior; server code for `/auth/device/*` + token validation is closed-source (upstream serves console from sst deploy; go/v1 chat key validation not visible).
- `x-org-id` on gateway traffic: sister sends it for session-chats; upstream asserts it only for `/api/config`. We keep `x-opencode-org-id` (current, working) for sessions and skip org headers for service keys.
- Google-surface models on the go gateway: go `lite` list observed without gemini; if a google-kind row ever reaches the go provider without `provider.api`, our fallback uses the go base — flagged for testing.
- The `/models` payload shape (`{data:[...]}` of ModelSource-like rows) is taken from `zen/v1/models.ts` (console app) — to be confirmed during task-2 fixtures.