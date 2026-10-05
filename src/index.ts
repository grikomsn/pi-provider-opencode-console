/**
 * pi extension entry: registers the OpenCode Console provider
 * (`opencode-console`) and the OpenCode Go provider (`opencode-go-console`)
 * with the shared device-auth OAuth flow, API-key (service key) auth, lazy
 * model discovery, and stream wrappers that delegate to pi-ai's built-in
 * API implementations.
 *
 * Auth model (upstream opencode console/go):
 * - Both providers authenticate device-code sessions through the shared
 *   Console OAuth device flow (`opencode-cli` client) and accept workspace
 *   `sk-` service keys (pi's standard `type: "api_key"` auth.json entries).
 * - Console: oauth session → org-scoped `/api/config` catalog; service
 *   key → public `https://opencode.ai/zen/v1/models` catalog.
 * - Go: always the public `https://opencode.ai/zen/go/v1/models` catalog
 *   (auth-ignored `lite` list); requests go to the Go gateway.
 * - Stored credential owns the provider (pi's one-credential-per-id rule);
 *   the `$OPENCODE_API_KEY` env template is the ambient fallback only when
 *   nothing is stored, matching upstream's own env convention.
 */

import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type {
	OAuthCredentials,
	OAuthLoginCallbacks,
	RefreshModelsContext,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import type { Context, Model, Api, AssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import {
	completeDeviceSignIn,
	DEFAULT_CONSOLE_SERVER,
	deleteSession,
	ensureFreshSession,
	envForSession,
	GO_PROVIDER_ID,
	listSessionOrgs,
	loadCredential,
	loadSession,
	mirrorOAuthTokens,
	PROVIDER_ID,
	requestDeviceCode,
	saveSession,
} from "./auth.ts";
import type { ConsoleSession } from "./auth.ts";
import { buildPiModels, loadConsoleConfig, loadPublicModels, toProviderModelConfigs } from "./models.ts";
import { streamConsoleWithSession } from "./stream.ts";
import type { BuiltModel } from "./models.ts";
import { registerCommand } from "./commands.ts";

/** The shared device-flow login used by both provider registrations. */
async function deviceLogin(
	providerId: string,
	callbacks: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
	const server = process.env.OPENCODE_CONSOLE_SERVER || DEFAULT_CONSOLE_SERVER;
	const fetcher: typeof fetch = (input, init) => fetch(input as never, init as never);
	const device = await requestDeviceCode(server, fetcher);
	callbacks.onDeviceCode({
		userCode: device.userCode,
		verificationUri: device.verificationUrl,
		intervalSeconds: Math.round(device.intervalMs / 1000),
		expiresInSeconds: Math.round((device.expiresAt - Date.now()) / 1000),
	});
	const session = await completeDeviceSignIn(device, {
		fetcher,
		signal: callbacks.signal,
		onProgress: callbacks.onProgress,
	});

	// Org selection (only if more than one).
	let chosenOrgId = session.orgId;
	let chosenOrgName = session.orgName;
	if (session.orgs.length > 1) {
		const options = session.orgs.map((o) => ({
			id: o.id,
			label: `${o.name} (${o.id})`,
		}));
		const picked = await callbacks.onSelect({
			message: "Select OpenCode Console organization",
			options,
		});
		if (picked) {
			const match = session.orgs.find((o) => o.id === picked);
			if (match) {
				chosenOrgId = match.id;
				chosenOrgName = match.name;
			}
		}
	}

	const finalSession = {
		...session,
		orgId: chosenOrgId,
		orgName: chosenOrgName,
	};
	await saveSession(finalSession, session.orgs, providerId);

	// Include `env` in the returned OAuthCredentials so pi's runtime
	// persists it verbatim to auth.json. Without this, refreshModels
	// would have no orgId/server/account info on next launch and
	// would short-circuit to an empty catalog.
	const credentials: OAuthCredentials = {
		refresh: finalSession.refreshToken,
		access: finalSession.accessToken,
		expires: finalSession.expiresAt,
		env: envForSession(finalSession, session.orgs),
	};
	return credentials;
}

/**
 * A single canonical refresh path for both providers: the Console device
 * flow is one shared session (upstream/sister semantics). Whichever
 * provider's token pi decides to refresh rotates the canonical session and
 * mirrors the rotated token fields into the sibling's oauth entry, so both
 * stay valid under refresh-token rotation. Canonicals are tried freshest
 * first, and a failed refresh (e.g. a dead refresh token on an older
 * lineage) falls back to the sibling's entry before escalating.
 */
async function sharedRefreshToken(
	_credentials: OAuthCredentials,
	signal: AbortSignal,
): Promise<OAuthCredentials> {
	const consoleCred = await loadCredential(PROVIDER_ID);
	const goCred = await loadCredential(GO_PROVIDER_ID);
	const candidates: { session: ConsoleSession; sourceId: string }[] = [];
	if (consoleCred?.kind === "oauth") {
		candidates.push({ session: consoleCred.session, sourceId: PROVIDER_ID });
	}
	if (goCred?.kind === "oauth") {
		candidates.push({ session: goCred.session, sourceId: GO_PROVIDER_ID });
	}
	if (!candidates.length) {
		throw new Error("OpenCode Console session missing; please /login again");
	}
	candidates.sort((a, b) => b.session.expiresAt - a.session.expiresAt);
	let lastError: unknown = new Error("OpenCode Console session missing; please /login again");
	for (const candidate of candidates) {
		try {
			const refreshed = await ensureFreshSession(candidate.session, true, fetch, signal);
			await saveSession(refreshed, undefined, candidate.sourceId);
			// Converge every oauth entry onto the rotated tokens (token fields
			// only; each entry keeps its own env/org choice).
			for (const siblingId of [PROVIDER_ID, GO_PROVIDER_ID]) {
				await mirrorOAuthTokens(refreshed, candidate.sourceId, siblingId);
			}
			return {
				refresh: refreshed.refreshToken,
				access: refreshed.accessToken,
				expires: refreshed.expiresAt,
				env: envForSession(refreshed),
			};
		} catch (err) {
			lastError = err;
		}
	}
	throw lastError;
}

function sharedGetApiKey(credentials: OAuthCredentials): string {
	return credentials.access;
}

/**
 * Session loader for `streamSimple`: resolves the service key or device
 * session (with per-provider fallback — the Go provider shares the Console
 * session), running inside the returned stream's async loop. `force` is set
 * when the server answered 401 mid-stream.
 */
function makeStreamLoader(providerId: string) {
	const fallbackId = providerId === GO_PROVIDER_ID ? PROVIDER_ID : GO_PROVIDER_ID;
	const notSignedIn = providerId === GO_PROVIDER_ID
		? "Not signed in to OpenCode Go; run /login opencode-go-console"
		: "Not signed in to OpenCode Console; run /login opencode-console";
	return async (opts?: { force?: boolean }) => {
		const force = opts?.force;
		const cred = (await loadCredential(providerId)) ?? (await loadCredential(fallbackId));
		if (!cred) {
			throw new Error(notSignedIn);
		}
		// Stored service keys are static: no refresh, no org identity.
		if (cred.kind === "api_key") {
			return { accessToken: cred.key, serviceKey: true };
		}
		const fresh = await ensureFreshSession(cred.session, force === true);
		return {
			accessToken: fresh.accessToken,
			orgId: fresh.orgId,
			requestId: crypto.randomUUID(),
			// The gateway surface also accepts `x-org-id` (sister parity);
			// `x-opencode-org-id` is injected by the stream wrapper itself.
			...(fresh.orgId ? { extraHeaders: { "x-org-id": fresh.orgId } } : {}),
		};
	};
}

/** Publish a built model list to pi's model store. */
async function publishModels(
	publish: RefreshModelsContext["publish"],
	configs: ProviderModelConfig[],
): Promise<void> {
	await publish({
		persist: {
			models: configs as unknown as Parameters<typeof publish>[0]["persist"] extends { persist?: infer P }
				? P
				: never,
			checkedAt: Date.now(),
		},
	});
}

export default function (pi: ExtensionAPI): void {
	pi.registerProvider(PROVIDER_ID, {
		name: "OpenCode Console",
		api: "openai-completions",
		models: [],
		// Registers API-key auth so pi's standard `{ type: "api_key", key }`
		// auth.json entries (service keys) resolve. Requests prefer the stored
		// credential; the env template is pi's ambient fallback when no
		// credential is stored — matching upstream's own `OPENCODE_API_KEY`.
		apiKey: "$OPENCODE_API_KEY",
		oauth: {
			name: "OpenCode Console (device sign-in)",
			isSubscription: true,
			login: (callbacks) => deviceLogin(PROVIDER_ID, callbacks),
			refreshToken: sharedRefreshToken,
			getApiKey: sharedGetApiKey,
		},
		async refreshModels(context) {
			const { signal, publish, credential, allowNetwork, stored } = context;
			// pi runs a cache-only pass (allowNetwork === false) during startup,
			// `-p`, and credential changes, then an optional network pass. Its
			// provider composer applies whatever this returns as the
			// authoritative catalog, so returning [] here would wipe the
			// persisted models. Serve the stored catalog instead.
			const cached = (stored?.models as unknown as ProviderModelConfig[] | undefined) ?? [];
			if (allowNetwork === false) return cached;
			try {
				// Service key (api_key credential): public Console `/models`
				// catalog (workspace-scoped filtering when the key is real).
				// Device session (oauth credential): org-scoped `/api/config`.
				const serviceKeyProviders =
					credential?.type === "api_key" && credential.key
						? await loadPublicModels("console", credential.key, fetch, signal)
						: undefined;
				const models: BuiltModel[] = serviceKeyProviders
					? buildPiModels(serviceKeyProviders)
					: await (async () => {
						const session = await loadSession();
						if (!session || !session.orgId) {
							return [] as BuiltModel[];
						}
						const fresh = await ensureFreshSession(session);
						if (!fresh.orgId) {
							return [] as BuiltModel[];
						}
						const providers = await loadConsoleConfig(
							fresh.server,
							fresh.accessToken,
							fresh.orgId,
							fetch,
							signal,
						);
						return buildPiModels(providers);
					})();
				const configs = toProviderModelConfigs(models);
				await publishModels(publish, configs);
				return configs;
			} catch {
				// Keep serving the last known catalog rather than clearing models.
				return cached;
			}
		},
		streamSimple(model, context, options) {
			// streamSimple must return an AssistantMessageEventStream
			// synchronously. Credential load + refresh happens inside the
			// returned stream, mirroring
			// `examples/extensions/custom-provider-gitlab-duo/index.ts`.
			return streamConsoleWithSession(
				model as Model<Api>,
				context as Context,
				makeStreamLoader(PROVIDER_ID),
				options as SimpleStreamOptions | undefined,
			);
		},
	});

	pi.registerProvider(GO_PROVIDER_ID, {
		name: "OpenCode Go",
		api: "openai-completions",
		models: [],
		apiKey: "$OPENCODE_API_KEY",
		oauth: {
			// Go subscriptions are managed in the OpenCode Console; device
			// sign-in for Go reuses the shared Console device flow.
			name: "OpenCode Go (device sign-in)",
			isSubscription: true,
			login: (callbacks) => deviceLogin(GO_PROVIDER_ID, callbacks),
			refreshToken: sharedRefreshToken,
			getApiKey: sharedGetApiKey,
		},
		async refreshModels(context) {
			const { signal, publish, credential, allowNetwork, stored } = context;
			// See the console provider: serve the persisted catalog for the
			// cache-only pass instead of returning an empty list.
			const cached = (stored?.models as unknown as ProviderModelConfig[] | undefined) ?? [];
			if (allowNetwork === false) return cached;
			try {
				// Go discovery is always the public `/models` catalog on the Go
				// gateway (`lite` list) — never the org-scoped `/api/config`.
				// With a Bearer token, workspace-disabled models are filtered.
				const token = credential?.type === "api_key" ? credential.key
					: credential?.type === "oauth" ? credential.access
					: undefined;
				const providers = await loadPublicModels("go", token, fetch, signal);
				const models = buildPiModels(providers, "go");
				const configs = toProviderModelConfigs(models);
				await publishModels(publish, configs);
				return configs;
			} catch {
				// Keep serving the last known catalog rather than clearing models.
				return cached;
			}
		},
		streamSimple(model, context, options) {
			return streamConsoleWithSession(
				model as Model<Api>,
				context as Context,
				makeStreamLoader(GO_PROVIDER_ID),
				options as SimpleStreamOptions | undefined,
			);
		},
	});

	registerCommand(pi);
}

// Re-export internal helpers for testing or extension composition.
export { deleteSession, listSessionOrgs };
