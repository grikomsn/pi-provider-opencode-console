# API-key removal plan — device-code-only auth (next major)

Goal `mv4jl2mu-794riv` task-1 inventory. Decision (user): **hard removal** — all
`api_key`/service-key code paths are deleted; stored `{ type: "api_key" }`
credentials simply stop resolving (pi shows "Provider is not configured"), and
README/CHANGELOG document the breaking change with re-login instructions.
Auth-facing copy is reworded to explicitly say "(OAuth)" or "device code" so the
remaining method reads unambiguously against pi's native API-key option.

## Why hard removal is safe (pi runtime facts)

- pi only resolves a stored `{ type: "api_key" }` credential when the provider
  registers `auth.apiKey` (`pi-ai/dist/auth/resolve.js`: stored `api_key`
  resolves **only if** `provider.auth.apiKey` exists; otherwise auth resolution
  returns undefined → "Provider is not configured").
- `composeApiKeyAuth` returns `undefined` for oauth-only extension providers
  ("OAuth-only providers get no fabricated API-key login method"),
  so dropping `apiKey` from registration also removes pi's native
  "Enter API key" `/login` prompt for these providers. No rejection code needed.

## A. src/ touchpoints to remove

| File | Change |
| --- | --- |
| `src/index.ts` | Remove `apiKey: "$OPENCODE_API_KEY"` from **both** registrations (:221, :292). Remove `serviceKeyProviders` branch in console `refreshModels` (:239–247) — always use the org-scoped `/api/config` path. Remove api_key branch in Go `refreshModels` (:312). Remove api_key branch + `serviceKey: true` in the `streamSimple` session loader (:165–183). Update file-header comments (:4, :11, :17). |
| `src/auth.ts` | Remove `ApiKeyJsonEntry` (:328), `ApiKeyStoredCredential` (:389), `resolveApiKeyEntry` (:406), the api_key branch of `loadCredential` (:428–430), and the api-key mention in the `mirrorOAuthTokens` docstring (:497). `StoredCredential` becomes just `OAuthStoredCredential`. Keep `summarizeKey` only if still used (device-code copy no longer masks keys — delete if unused). |
| `src/commands.ts` | Delete `serviceKeyCommand` (:126–157) and the `cred.kind === "api_key"` dispatch (:85–86) and its import. Status output for device sessions gets the copy rewording (below). |
| `src/models.ts` | `loadPublicModels(mode, key?)` is only reachable with a service key today; after removal the device-session paths never call it. Remove it plus `buildPiModels`'s public-catalog fixtures usage **if unused** — check remaining callers; if the public `/models` catalog becomes dead code, delete it and its helpers. |
| `src/stream.ts` | Remove `serviceKey` flag (:144–145), the "terminal 401" special case (:285–286 — keep the refresh retry unconditional for oauth), and reword comments mentioning service keys (:203–206, :244–245). |
| `src/endpoint.ts` | Reword the header comment (:33) — "both accept workspace `sk-` service keys" → device-code only. Keep `x-api-key` / `x-goog-api-key` gateway header mappings (:76, :87) — those are **gateway route headers carrying the OAuth access token**, not service-key auth. |

Non-goals (kept): device flow, refresh/mirror logic, org scoping, `x-opencode-org-id`
headers, Go gateway routing.

## B. Tests to remove/rewrite

- `test/auth.test.ts`: delete "loadCredential resolves a stored service key",
  "treats an empty api_key entry as missing", "summarizeKey masks service keys";
  keep "mirrorOAuthTokens skips missing and api-key siblings" only as a
  "unknown sibling entries are untouched" test (rename, keep the shape check).
- `test/index.test.ts`: delete "registration exposes API-key auth",
  "refreshModels loads the public /models catalog for an api_key credential",
  "streamSimple uses a stored service key", "api_key credential: Bearer service
  key" case, "go streamSimple falls back to the console service key". **Add**
  an assertion that `cfg.apiKey` is `undefined` (oauth-only registration).
- `test/models.test.ts`: delete the whole "public /models catalog (service keys
  + go mode)" section if `loadPublicModels` is removed.
- `test/commands.test.ts`: delete "status reports and masks a stored service
  key", "switch-org is rejected for service keys", "refresh with a service key",
  and the go api_key case.
- `test/stream.test.ts`: delete "treats a service-key 401 as terminal" and
  "omits org identity headers for service-key requests".
- `test/endpoint.test.ts`: keep — header-mapping tests are route headers, not auth method.

## C. User-facing copy rewording ("(OAuth)" / "device code")

| Location | Current | Proposed |
| --- | --- | --- |
| `src/index.ts` :223 | `OpenCode Console (device sign-in)` | `OpenCode Console (OAuth device code)` — shown in pi's `/login` provider method list, distinct from pi's native "Enter API key" |
| `src/index.ts` :296 | `OpenCode Go (device sign-in)` | `OpenCode Go (OAuth device code)` |
| `src/commands.ts` status | `Auth: device-code session (…)` style lines | Ensure it says "device code (OAuth)"; drop all service-key lines |
| `src/commands.ts` switch-org | "switch-org requires a device-code session; …" | Keep, minus service-key phrasing: "switch-org requires a device-code (OAuth) session; sign in again to switch." |

Sister-project reference for tone: `opencode-copilot-chat` labels its actions
"Sign in … (device code)" (`src/commands/commands.ts:50,56`) — we mirror that
explicitness. `tanstack-ai-opencode-console` keeps both `apiKey` + `session`,
but it is a library API, not a pi provider registration, so its dual-method
design does not apply here.

## D. Docs & metadata

- `README.md`: remove the "Service keys (alternative)" section and service-key
  rows in the catalog table; state device-code (OAuth) sign-in is the only
  method, explain it differs from pi's native API-key option / built-in
  `opencode` providers, and add a "migrating from service keys" note (stored
  `api_key` entries become inert → delete them and run device sign-in).
  Update the architecture diagram lines (:102–108).
- `CHANGELOG.md`: new unreleased `2.0.0` section with a `BREAKING` entry.
- `package.json`: version → `2.0.0`; description/keywords drop "service keys".
- `docs/opencode-auth-parity.md`: append a "2026 update: service keys removed"
  annotation; history stays as research record.

## E. Verification sequence

1. `npm test` — 0 failures.
2. `grep -rniE 'api_key|service.?key|OPENCODE_API_KEY' src/` — only
   gateway-header (`x-api-key`) hits and history docs remain.
3. Isolated pi instance (redirected `HOME`): extension loads, `/login` offers
   only "…(OAuth device code)" (no "Enter API key"), device login completes,
   model streams.
4. PR to `grikomsn/pi-provider-opencode-console` for the next major.
