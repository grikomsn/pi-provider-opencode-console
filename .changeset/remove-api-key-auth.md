---
"pi-provider-opencode-console": major
---

**BREAKING: API-key (service key) auth removed — device-code (OAuth) sign-in is now the only auth method.**

Both providers (`opencode-console`, `opencode-go-console`) register OAuth-only auth, so pi's `/login` offers just the "…(OAuth device code)" path — the native "Enter API key" prompt is gone, and stored `{ "type": "api_key" }` auth.json entries no longer resolve ("Provider is not configured").

- Removed the `apiKey: "$OPENCODE_API_KEY"` registration, service-key credential resolution, the `serviceKey` stream flag and its terminal-401 behavior, the service-key `/models` catalog paths, and the service-key command branches (status/masking, switch-org rejection, key-based refresh).
- Console model discovery is always the org-scoped `/api/config` catalog; Go keeps the public `/models` catalog, now called with the session's access token.
- Auth-facing copy now says "(OAuth)" / "device code" so the method reads unambiguously against pi's native API-key option (e.g. provider names "OpenCode Console (OAuth device code)", status "Auth: device-code (OAuth) session").
- **Migrating:** delete any `api_key` entries for these provider ids from `~/.pi/agent/auth.json` (they are inert) and run `/login opencode-console` (or `/login opencode-go-console`).
