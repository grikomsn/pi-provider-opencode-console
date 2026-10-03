/**
 * Wraps a `streamSimple` handler that delegates to the appropriate built-in
 * pi-ai API implementation (Anthropic Messages / OpenAI Completions /
 * OpenAI Responses / Google Generative AI). The wrapper injects per-route
 * authentication headers plus OpenCode Console identity headers.
 *
 * OpenCode Console uses TWO different auth headers depending on the surface:
 * - /api/config (catalog): `x-org-id` (handled in `loadConsoleConfig`)
 * - /inference/<api>/v1 (chat): `x-opencode-org-id` (injected here)
 *
 * The `pi` runtime strips per-model `headers` returned by `refreshModels`
 * (see `provider-composer.applyExtension` hardcoding `headers: undefined`),
 * so we cannot rely on per-model config. The `x-opencode-org-id` header
 * MUST be supplied on each request via `extraHeaders`.
 *
 * The delegation pattern mirrors `examples/extensions/custom-provider-gitlab-duo/index.ts`:
 * we let the upstream pi-ai module handle dialect parsing and event emission,
 * and only adapt the request envelope.
 */

import {
	type Api,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type ProviderStreams,
	type SimpleStreamOptions,
	anthropicMessagesApi,
	createAssistantMessageEventStream,
	googleGenerativeAIApi,
	openAICompletionsApi,
	openAIResponsesApi,
} from "@earendil-works/pi-ai/compat";
import { baseUrlFor, routeFor, type ApiKind } from "./endpoint.ts";
import {
	isTransientNetworkError,
	isTransientServerError,
	patchableOptionFrom400,
	retryDelayMs,
	statusFromErrorMessage,
} from "./retry.ts";

const MAX_TRANSIENT_RETRIES = 2;
const MAX_PATCH_RETRIES = 2;

function signalSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new Error("aborted"));
			return;
		}
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(new Error("aborted"));
			},
			{ once: true },
		);
	});
}

function buildErrorEvent(
	model: Model<Api>,
	reason: "error" | "aborted",
	errorMessage: string,
) {
	return {
		type: "error" as const,
		reason,
		error: {
			role: "assistant" as const,
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0,
				},
			},
			stopReason: reason,
			errorMessage,
			timestamp: Date.now(),
		},
	};
}

const apiMap: Record<ApiKind, () => ProviderStreams> = {
	"anthropic-messages": anthropicMessagesApi,
	"openai-completions": openAICompletionsApi,
	"openai-responses": openAIResponsesApi,
	"google-generative-ai": googleGenerativeAIApi,
};

export interface StreamContext {
	accessToken: string;
	orgId?: string;
	requestId?: string;
	clientName?: string;
	extraHeaders?: Record<string, string>;
	/**
	 * Called when the server answers 401 mid-stream: force-refreshes the
	 * session and returns a context with a fresh access token. Retries
	 * happen once; without this callback the error is surfaced as-is.
	 */
	refreshSession?: () => Promise<StreamContext>;
}

/**
 * Wraps the models `baseUrl` and delegates to the built-in streaming
 * implementation. The wrapper injects per-route auth headers and OpenCode
 * Console identity headers (`x-opencode-org-id`, `x-opencode-client`),
 * and retries recoverable failures before any content has been forwarded:
 * transient network/server errors (bounded, with backoff), 401 (one
 * forced session refresh via `streamCtx.refreshSession`), and 400s whose
 * message names a rejected option (the option is dropped and the request
 * retried).
 *
 * pi-ai only pushes its `start` event after the HTTP response succeeds, so
 * HTTP-level failures always arrive before any event — the retry policy
 * never re-sends a partially-consumed response.
 *
 * Returns an `AssistantMessageEventStream` immediately; the inner stream
 * runs on a microtask so callers can iterate the returned stream
 * synchronously.
 */
export function streamConsole(
	model: Model<Api>,
	context: Context,
	streamCtx: StreamContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	(async () => {
		try {
			const apiKind = model.api as ApiKind;
			const apiFactory = apiMap[apiKind];
			if (!apiFactory) {
				throw new Error(`Unsupported OpenCode Console API kind: ${String(model.api)}`);
			}
			const overridden: Model<Api> = {
				...model,
				baseUrl: baseUrlFor(model.baseUrl, apiKind),
			};

			// For Anthropic and Google, the built-in API modules set their
			// own auth header (`x-api-key` / `x-goog-api-key`) from
			// `options.apiKey`. For OpenAI-compat APIs they read
			// `Authorization: Bearer` from `options.headers`. We pass
			// apiKey directly and let the inner module own its auth header.
			// route.authHeader is exposed for tests and external callers.
			void routeFor(apiKind);

			let ctx = streamCtx;
			let currentOptions: SimpleStreamOptions | undefined = options;
			let usedAuthRetry = false;
			let transientRetries = 0;
			let patchRetries = 0;

			while (true) {
				const headers: Record<string, string> = {
					...(ctx.extraHeaders ?? {}),
					...(currentOptions?.headers as Record<string, string> | undefined),
					"x-opencode-client": ctx.clientName ?? "pi-provider-opencode-console",
				};
				// `/inference/*` requires the Console's workspace/org header.
				// `/api/config` uses `x-org-id` instead, but that's only called
				// from `loadConsoleConfig`, which is outside this code path.
				if (ctx.orgId) headers["x-opencode-org-id"] = ctx.orgId;
				if (ctx.requestId) headers["x-opencode-request"] = ctx.requestId;

				const innerOpts: SimpleStreamOptions = {
					...currentOptions,
					apiKey: ctx.accessToken,
					headers,
				};

				const inner = apiFactory().streamSimple(overridden, context, innerOpts);
				let errorMessage: string | undefined;
				let completed = false;
				let forwarded = 0;
				try {
					for await (const event of inner) {
						if (event.type === "error") {
							errorMessage = event.error.errorMessage;
							break;
						}
						stream.push(event);
						forwarded++;
						if (event.type === "done") {
							completed = true;
							break;
						}
					}
				} catch (err) {
					if (isTransientNetworkError(err) && forwarded === 0 && transientRetries < MAX_TRANSIENT_RETRIES) {
						try {
							await signalSleep(retryDelayMs(transientRetries), options?.signal);
						} catch {
							break; // aborted during backoff
						}
						transientRetries++;
						continue;
					}
					errorMessage = err instanceof Error ? err.message : String(err);
				}
				if (completed) break;

				const status = errorMessage ? statusFromErrorMessage(errorMessage) : undefined;
				// 401: the access token was rejected — force-refresh once and retry.
				if (status === 401 && forwarded === 0 && !usedAuthRetry && ctx.refreshSession) {
					usedAuthRetry = true;
					ctx = await ctx.refreshSession();
					continue;
				}
				// 400 naming a rejected option: drop it from the request and retry.
				if (status === 400 && forwarded === 0 && patchRetries < MAX_PATCH_RETRIES && errorMessage) {
					const field = patchableOptionFrom400(errorMessage);
					if (field && currentOptions?.[field] !== undefined) {
						const next = { ...currentOptions } as SimpleStreamOptions;
						delete next[field];
						currentOptions = next;
						patchRetries++;
						continue;
					}
				}
				// Transient gateway/server failure: back off and retry.
				if (
					forwarded === 0 &&
					transientRetries < MAX_TRANSIENT_RETRIES &&
					((status !== undefined && isTransientServerError(status, errorMessage ?? "")) ||
						(status === undefined && errorMessage !== undefined && isTransientNetworkError(new Error(errorMessage))))
				) {
					try {
						await signalSleep(retryDelayMs(transientRetries), options?.signal);
					} catch {
						break; // aborted during backoff
					}
					transientRetries++;
					continue;
				}

				const reason: "error" | "aborted" = options?.signal?.aborted ? "aborted" : "error";
				stream.push(buildErrorEvent(model, reason, errorMessage ?? "OpenCode Console stream failed"));
				break;
			}
			stream.end();
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err);
			const reason: "error" | "aborted" = options?.signal?.aborted ? "aborted" : "error";
			stream.push(buildErrorEvent(model, reason, errorMessage));
			stream.end();
		}
	})();
	return stream;
}

/**
 * Same as `streamConsole` but resolves the access token + orgId lazily via
 * `getSession` before the first request. It is invoked again with
 * `{ force: true }` when the server answers 401 so the session can
 * force-refresh its access token.
 * Used by the `streamSimple` handler so that session loading happens inside
 * the returned stream's async loop (preserving the synchronous-return
 * contract).
 */
export function streamConsoleWithSession(
	model: Model<Api>,
	context: Context,
	getSession: (opts?: { force?: boolean }) => Promise<StreamContext>,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	(async () => {
		try {
			options?.signal?.throwIfAborted();
			const session = await getSession();
			options?.signal?.throwIfAborted();
			const inner = streamConsole(model, context, {
				...session,
				refreshSession: async () => getSession({ force: true }),
			}, options);
			for await (const event of inner) {
				stream.push(event);
			}
		} catch (err) {
			const errorMessage = err instanceof Error ? err.message : String(err);
			const reason: "error" | "aborted" = options?.signal?.aborted ? "aborted" : "error";
			stream.push(buildErrorEvent(model, reason, errorMessage));
		} finally {
			stream.end();
		}
	})();
	return stream;
}
