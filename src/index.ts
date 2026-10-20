/**
 * pi extension entry: registers the OpenCode Console provider
 * (`opencode-console`) and the OpenCode Go provider (`opencode-go-console`)
 * with the shared device-auth OAuth flow, lazy model discovery, and stream
 * wrappers that delegate to pi-ai's built-in API implementations.
 *
 * Auth model (OAuth device code only):
 * - Both providers authenticate through the shared Console OAuth device
 *   flow (`opencode-cli` client). API-key (service key) auth was removed —
 *   these providers register no `apiKey` method, so pi offers only the
 *   device-code sign-in path and stored `api_key` auth.json entries no
 *   longer resolve.
 * - Console: org-scoped `/api/config` catalog.
 * - Go: always the public `https://opencode.ai/inference/go/v1/models` catalog
 *   (`lite` list), called with the session's access token; requests go to
 *   the Go gateway.
 * - The stored oauth credential owns the provider (pi's
 *   one-credential-per-id rule).
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
import {
	buildPiModels,
	buildProviderSources,
	fetchPublicModelsRows,
	getModelsDevSnapshot,
	GO_FALLBACK_MODELS,
	loadConsoleConfig,
	toProviderModelConfigs,
	type ModelConfigSource,
} from "./models.ts";
import { streamConsoleWithSession } from "./stream.ts";
import { EXTENSION_API } from "./endpoint.ts";
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

	// Org selection: the device grant may have scoped the session to an org
	// chosen during browser approval (orgId set, scopedOrgId present). Only
	// prompt when the session has no org yet and the account has multiple —
	// never auto-pin; single-org accounts are pre-selected by the auth layer.
	let chosenOrgId = session.orgId;
	let chosenOrgName = session.orgName;
	if (!session.orgId && session.orgs.length > 1) {
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
 * Session loader for `streamSimple`: resolves the device-code OAuth
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

/**
 * Publish a built model list to pi's model store and return it (the single
 * publication path: refreshModels both publishes its persisted snapshot and
 * returns the same list to the caller's composer).
 */
async function publishAndReturn(
	publish: RefreshModelsContext["publish"],
	configs: ProviderModelConfig[],
): Promise<ProviderModelConfig[]> {
	// The composer always supplies publish(); tolerate its absence the way
	// older test harnesses do.
	await publish?.({
		persist: {
			models: configs as unknown as Parameters<typeof publish>[0]["persist"] extends { persist?: infer P }
				? P
				: never,
			checkedAt: Date.now(),
		},
	});
	return configs;
}

/**
 * The catalog refresh both providers share:
 *
 * - Cache-only pass (`allowNetwork === false`, startup/`-p`): publish and
 *   serve the persisted catalog synchronously — never a network hop, so the
 *   model snapshot shows the OpenCode providers as early as possible.
 * - Network pass: live discovery, then publish. The Go flow publishes in
 *   two phases: rows-only first (bundled supplemental metadata requires no
 *   network), then models.dev enrichment — so live models surface before
 *   the ~5MB enrichment payload lands. When `/models` is unreachable and
 *   nothing is persisted yet, the bundled Go fallback ids keep the
 *   provider visible offline.
 */
async function refreshProviderCatalog(
	providerId: string,
	context: RefreshModelsContext,
): Promise<ProviderModelConfig[]> {
	const { signal, publish, credential, allowNetwork, stored } = context;
	// pi's provider composer applies whatever we return as the authoritative
	// catalog; returning [] would wipe the persisted models. Serve and
	// re-publish the stored catalog for the cache-only pass.
	const cached = (stored?.models as unknown as ProviderModelConfig[] | undefined) ?? [];
	if (allowNetwork === false) {
		return publishAndReturn(publish, cached);
	}
	try {
		if (providerId === GO_PROVIDER_ID) {
			return await refreshGoCatalog(context, cached);
		}
		// Device-code session: org-scoped `/api/config` catalog.
		const session = await loadSession();
		if (!session || !session.orgId) {
			return publishAndReturn(publish, []);
		}
		const fresh = await ensureFreshSession(session);
		if (!fresh.orgId) {
			return publishAndReturn(publish, []);
		}
		const providers = await loadConsoleConfig(fresh.server, fresh.accessToken, fresh.orgId, fetch, signal);
		return publishAndReturn(publish, toProviderModelConfigs(buildPiModels(providers)));
	} catch (error) {
		if (signal?.aborted) throw error;
		// Keep serving the last known catalog rather than clearing models.
		return publishAndReturn(publish, cached);
	}
}

/**
 * Go discovery: the public `/models` catalog on the Go gateway (`lite`
 * list) — never the org-scoped `/api/config`. With the session's Bearer
 * access token, workspace-disabled models are filtered server-side.
 */
async function refreshGoCatalog(
	{ signal, publish, credential }: RefreshModelsContext,
	cached: ProviderModelConfig[],
): Promise<ProviderModelConfig[]> {
	const token = credential?.type === "oauth" ? credential.access : undefined;
	let rows: ModelConfigSource[];
	try {
		rows = await fetchPublicModelsRows("go", token, fetch, signal);
	} catch (error) {
		if (signal?.aborted) throw error;
		if (cached.length > 0) {
			// A persisted catalog is fresher than the bundled static snapshot.
			return publishAndReturn(publish, cached);
		}
		rows = [...GO_FALLBACK_MODELS];
	}
	// Phase 1: rows-only post-processing with bundled metadata (no network);
	// publish immediately so the provider becomes visible before enrichment.
	let configs = toProviderModelConfigs(buildPiModels(buildProviderSources("go", rows, undefined), "go"));
	await publishAndReturn(publish, configs);
	// Phase 2: models.dev enrichment (best effort — bundled supplements
	// already covered ids models.dev lacks; a failed fetch keeps phase 1).
	const dev = await getModelsDevSnapshot("go", fetch, signal);
	if (dev) {
		const enriched = toProviderModelConfigs(buildPiModels(buildProviderSources("go", rows, dev), "go"));
		if (enriched.length > 0) {
			configs = enriched;
			await publishAndReturn(publish, configs);
		}
	}
	return configs;
}

export default function (pi: ExtensionAPI): void {
	pi.registerProvider(PROVIDER_ID, {
		name: "OpenCode Console",
		api: EXTENSION_API,
		models: [],
		// OAuth-only: no `apiKey` registration, so pi's /login offers just
		// the device-code path (pi's native "Enter API key" method is not
		// available for these providers).
		oauth: {
			name: "OpenCode Console (OAuth device code)",
			isSubscription: true,
			login: (callbacks) => deviceLogin(PROVIDER_ID, callbacks),
			refreshToken: sharedRefreshToken,
			getApiKey: sharedGetApiKey,
		},
		async refreshModels(context) {
			return refreshProviderCatalog(PROVIDER_ID, context);
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
		api: EXTENSION_API,
		models: [],
		oauth: {
			// Go subscriptions are managed in the OpenCode Console; device
			// sign-in for Go reuses the shared Console device flow.
			name: "OpenCode Go (OAuth device code)",
			isSubscription: true,
			login: (callbacks) => deviceLogin(GO_PROVIDER_ID, callbacks),
			refreshToken: sharedRefreshToken,
			getApiKey: sharedGetApiKey,
		},
		async refreshModels(context) {
			return refreshProviderCatalog(GO_PROVIDER_ID, context);
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
