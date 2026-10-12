# Streaming 404 diagnosis + org-scoped sign-in revision (goal mv4jl2mu-794riv)

## 1. Streaming 404 — root cause (confirmed 2026-10-12)

Isolated-pi smoke test: device login OK, catalog OK (`/api/config` 200), but
chat on `claude-fable-5-1` failed with `404 (no body)`.

Fetch log (via debug extension in the real TUI):

```
POST https://opencode.ai/inference/anthropic/v1/v1/messages?beta=true -> 404
```

- Doubled `/v1` + `?beta=true` ⇒ the request came from pi **runtime** pi-ai
  1.1.0 (`client.beta.messages.create` → path `/v1/messages?beta=true`), NOT
  from our `streamConsole` wrapper (repo pi-ai 0.84.2 uses
  `client.messages.create` → `/v1/messages`, and our `baseUrlFor` strips
  `/v1`; a direct repro through our wrapper produced the correct single-`/v1`
  URL and reached the gateway — curl on `/inference/anthropic/v1/messages`
  returns 200 with both `x-api-key` and `Bearer` auth styles).
- Why our wrapper was bypassed: `provider-composer.js` dispatch
  (both runtime 1.1.0 and vendored 0.84.2):

  ```js
  if (extension?.streamSimple && model.api === extension.api) {
      return extension.streamSimple(model, context, options);
  }
  // else: built-in API implementation with the model's RAW catalog baseUrl
  ```

  We register `api: "openai-completions"` but `buildPiModels` emits per-model
  `api: "anthropic-messages" | "openai-responses" | "google-generative-ai" |
  "openai-completions"` (from `resolveRoute`). Any model whose routed api ≠
  `openai-completions` skips our wrapper; the built-in anthropic/google
  implementations then append their own `/v1/...` path to the un-stripped
  catalog baseUrl (`.../inference/anthropic/v1`) → `/v1/v1/...` → 404.
  **Pre-existing bug** (present in 1.0.x too); only surfaced now because the
  smoke test exercised an anthropic-routed model end-to-end.

### Fix design (flatten + wireApi)

- `buildPiModels` emits `api: "openai-completions"` (the registered
  extension api) for EVERY model, and moves the real wire route into a
  custom `wireApi` field (same pattern as the existing `wireId` custom field,
  which pi preserves through `extensionModelFromDefinition`).
- `streamConsole` derives `apiKind` as `model.wireApi ?? model.api`, builds
  `overridden` with `api: apiKind` (real kind) + `baseUrlFor(baseUrl, apiKind)`
  so the inner per-API implementation sees the right kind and URL.
- Result: every model passes the composer gate → our wrapper handles all
  models → correct URL strip, `x-opencode-org-id` / `x-opencode-session` /
  tracing headers, 401-refresh, and patch retries for every route.
- Tests: keep existing streamConsole tests (they pass `api` directly —
  fallback still works); add cases asserting the composer gate is satisfied
  (`config.api === "openai-completions"` while model configs carry
  `api: "openai-completions"` + `wireApi` route).

## 2. Org-scoped device sign-in (user-requested revision; sister parity)

Reference: `../opencode-copilot-chat` commit `4d8d943` (#66) +
`docs/org-scoped-device-auth-plan.md`; identical protocol in
`../tanstack-ai-opencode-console` `packages/tanstack-ai-opencode-console/src/auth.ts`
(`supports_org_scope` :192, `scopedOrgId` :33/:340-354, refresh :393-413,
scoped-switch block :546).

Protocol:
1. `POST /auth/device/code` body: `{ client_id, supports_org_scope: true }` —
   opt in to server-side org binding (org is chosen during browser approval).
2. Token grant response may carry `org_id`; validate against `/api/orgs`
   result; session becomes server-scoped (`scopedOrgId`), org picker skipped.
3. Fallback when no `org_id`: single-org account auto-selects; multi-org →
   explicit picker after sign-in (do NOT auto-select first org).
4. `switch-org` rejected for scoped sessions ("sign in again to switch").
5. Refresh: response may carry `org_id` — scope change ⇒ error; omitted ⇒ keep;
   new `org_id` on an un-scoped session ⇒ adopt (persisted).

Our touchpoints:
- `src/auth.ts` `requestDeviceCode` (add flag), `completeDeviceSignIn` (parse
  grant `org_id`, set `scopedOrgId`, drop first-org auto-select), refresh
  path (`ensureFreshSession` → parse refresh `org_id`), `ConsoleSession`
  gains `scopedOrgId?`, `envForSession`/`sessionFromEntry` persist it
  (`OPENCODE_CONSOLE_SCOPED_ORG_ID`).
- `src/index.ts` `deviceLogin`: prompt only when `!session.orgId && orgs.length > 1`.
- `src/commands.ts` `switchOrg`: reject when `session.scopedOrgId`; status
  line shows "(server-scoped)" marker.
- Tests: grant-with-org, unknown-org failure, single-org auto-select,
  multi-org deferral to picker, scoped switch-org rejection, refresh
  scope-keep/change-reject/adopt.

## 3. Smoke-test state

- Isolated HOME `/tmp/pi-smoke.ZL4VTe` holds a live un-scoped oauth session
  (org `wrk_01KQ25AJRFKQDYB04QPEM2PN5C`, Nibras Enterprises).
- Verified already: extension loads isolated; `/login` shows only
  "Sign in with an account / API key / Radius" at top level, and selecting
  OpenCode Console goes STRAIGHT to device code (no "Enter API key" path);
  device login + org picker + credential persistence all work; org-scoped
  catalog loads.
- Blocked on: streaming 404 (fix in §1), then re-smoke with org-scoped
  sign-in (§2). Headless `pi auth check`/`-p` hang when stdin is an open
  pipe (pi waits on stdin) — use a PTY or `< /dev/null` when driving pi.
