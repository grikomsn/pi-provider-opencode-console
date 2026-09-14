/**
 * pi extension entry: registers the `opencode-console` provider with
 * device-auth OAuth flow, lazy model discovery via `/api/config`, and a
 * stream wrapper that delegates to pi-ai's built-in API implementations.
 */

import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials } from "@earendil-works/pi-ai/compat";
import {
	completeDeviceSignIn,
	DEFAULT_CONSOLE_SERVER,
	deleteSession,
	ensureFreshSession,
	envForSession,
	listSessionOrgs,
	loadSession,
	requestDeviceCode,
	saveSession,
} from "./auth.ts";
import { buildPiModels, loadConsoleConfig, toProviderModelConfigs } from "./models.ts";
import { streamConsoleWithSession } from "./stream.ts";
import { registerCommand } from "./commands.ts";

export default function (pi: ExtensionAPI): void {
	pi.registerProvider("opencode-console", {
		name: "OpenCode Console",
		api: "openai-completions",
		models: [],
		oauth: {
			name: "OpenCode Console (device sign-in)",
			isSubscription: true,
			async login(callbacks) {
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
				await saveSession(finalSession, session.orgs);

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
			},
			async refreshToken(credentials, signal) {
				// Pi gives us only `{refresh, access, expires}`; the env block
				// is lost. Re-derive it from the persisted auth.json so we can
				// hand it back to pi unchanged.
				const session = await loadSession();
				if (!session) {
					throw new Error("OpenCode Console session missing; please /login again");
				}
				const refreshed = await ensureFreshSession(session, true, fetch, signal);
				await saveSession(refreshed);
				return {
					refresh: refreshed.refreshToken,
					access: refreshed.accessToken,
					expires: refreshed.expiresAt,
					env: envForSession(refreshed),
				};
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		},

		async refreshModels({ signal, publish }) {
			const session = await loadSession();
			if (!session || !session.orgId) {
				return [] as ProviderModelConfig[];
			}
			try {
				const fresh = await ensureFreshSession(session);
				if (!fresh.orgId) {
					return [] as ProviderModelConfig[];
				}
				const providers = await loadConsoleConfig(
					fresh.server,
					fresh.accessToken,
					fresh.orgId,
					fetch,
					signal,
				);
				const models = buildPiModels(providers);
				const configs = toProviderModelConfigs(models);
				await publish({
					persist: {
						models: configs as ProviderModelConfig[] & unknown[],
						checkedAt: Date.now(),
						generation: Date.now(),
					} as unknown as Parameters<typeof publish>[0]["persist"],
				});
				return configs;
			} catch {
				// Console deliberately hides models on failure; don't surface stale list.
				return [] as ProviderModelConfig[];
			}
		},

		streamSimple(model, context, options) {
			// streamSimple must return an AssistantMessageEventStream
			// synchronously. Session load + refresh happens inside the
			// returned stream, mirroring
			// `examples/extensions/custom-provider-gitlab-duo/index.ts`.
			return streamConsoleWithSession(model, context, async ({ force } = {}) => {
				const session = await loadSession();
				if (!session) {
					throw new Error("Not signed in to OpenCode Console; run /login opencode-console");
				}
				// `force` is set when the server answered 401 mid-stream: refresh
				// the access token even if it has not reached its expiry clock.
				const fresh = await ensureFreshSession(session, force === true);
				return {
					accessToken: fresh.accessToken,
					orgId: fresh.orgId,
					requestId: crypto.randomUUID(),
				};
			}, options);
		},
	});

	registerCommand(pi);
}

// Re-export internal helpers for testing or extension composition.
export { deleteSession, listSessionOrgs };
