# Changelog

## 0.0.2

### Patch Changes

- 20afea4: Add the `pullfrog.yml` workflow to mirror the sibling `pi-provider-poolside` setup.

## 0.0.1

- Initial release: Pi provider for OpenCode Console via OAuth 2.0 device authorization grant.
- Discover account-specific models from the org-scoped `/api/config` endpoint.
- Route chat requests to the right upstream wire API per-model (`anthropic-messages`, `openai-completions`, `openai-responses`, `google-generative-ai`), delegating streaming and parsing to pi-ai's built-in implementations.
- Auto-refresh the OAuth access token within 5 minutes of expiry, single-flight.
- Add `/opencode-console` for `status`, `refresh`, `switch-org`, and `logout`.
- Tests, package metadata, Changesets, CI, and npm trusted publishing.
