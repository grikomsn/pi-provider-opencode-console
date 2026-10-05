/**
 * Maps an OpenCode Console model descriptor to a concrete wire API and
 * the auth header / URL that wire expects.
 *
 * The mapping prefers the upstream `npm` package id when the descriptor
 * provides one (Anthropic, OpenAI Responses, Google Generative AI SDKs),
 * and falls back to model-id prefix heuristics.
 *
 * URL normalization:
 *   - `anthropic-messages`: baseUrl from `/api/config` includes `/v1`;
 *     strip it because the Anthropic SDK appends `/v1/messages` itself.
 *   - `openai-completions` / `openai-responses`: keep baseUrl (typically
 *     already `/v1`); SDK appends `chat/completions` or `responses`.
 *   - `google-generative-ai`: keep baseUrl (the Google AI SDK expects
 *     the API root, e.g. `/v1beta`, and adds `/models/<id>:
 *     streamGenerateContent` itself).
 */

export type ApiKind =
	| "anthropic-messages"
	| "openai-completions"
	| "openai-responses"
	| "google-generative-ai";

/** Public chat-completions/catalog base of the Console (former Zen) gateway. */
export const CONSOLE_API_BASE_URL = "https://opencode.ai/zen/v1";
/** Public model-catalog/chat base of the Go (subscription, `lite` list) gateway. */
export const GO_API_BASE_URL = "https://opencode.ai/zen/go/v1";

/**
 * `OpenCodeMode` mirrors upstream's two auth systems after the Zen→Console
 * merge: both Console and Go authenticate device-code sessions via the shared
 * Console device flow, and both accept workspace `sk-` service keys.
 */
export type OpenCodeMode = "console" | "go";

/** Public `/models` catalog base for a mode (console zen `full`, go `lite`). */
export function apiBaseForMode(mode: OpenCodeMode): string {
	return mode === "go" ? GO_API_BASE_URL : CONSOLE_API_BASE_URL;
}

export function resolveRoute(modelId: string, npm?: string, mode: OpenCodeMode = "console"): ApiKind {
	const pkg = (npm ?? "").toLowerCase();
	if (pkg.includes("anthropic")) return "anthropic-messages";
	if (pkg.includes("google")) return "google-generative-ai";
	if (pkg === "@ai-sdk/openai" || pkg.endsWith("/openai")) return "openai-responses";
	// Fallback heuristics by model id.
	if (/^gpt-/i.test(modelId)) return "openai-responses";
	if (/^claude-/i.test(modelId)) return "anthropic-messages";
	// Family-wide routes (sibling parity): every live grok*, muse-spark* and
	// qwen* model on the gateways is responses or messages, and models.dev
	// omits `npm` for some of them — the id prefix is the only signal left.
	// Family-scoped: minimax and gemini only appear on their own gateway.
	if (/^grok(?:-|$)/i.test(modelId)) return "openai-responses";
	if (/^muse-spark-/i.test(modelId)) return "openai-responses";
	// The endpoint table gives this model a different API from other Qwen
	// models: it is OpenAI-completions on both gateways (pi's official config
	// agrees; tanstack router + pi.dev pages corroborate).
	if (/^qwen3\.8-max$/i.test(modelId)) return "openai-completions";
	if (/^qwen/i.test(modelId)) return "anthropic-messages";
	if (mode === "go" && /^minimax-/i.test(modelId)) return "anthropic-messages";
	if (mode === "console" && /^gemini-/i.test(modelId)) return "google-generative-ai";
	return "openai-completions";
}

export interface RouteInfo {
	api: ApiKind;
	authHeader: (token: string) => Record<string, string>;
}

export function routeFor(api: ApiKind): RouteInfo {
	switch (api) {
		case "anthropic-messages":
			return {
				api,
				authHeader: (t) => ({ "x-api-key": t, "anthropic-version": "2023-06-01" }),
			};
		case "openai-responses":
		case "openai-completions":
			return {
				api,
				authHeader: (t) => ({ Authorization: `Bearer ${t}` }),
			};
		case "google-generative-ai":
			return {
				api,
				authHeader: (t) => ({ "x-goog-api-key": t }),
			};
	}
}

/**
 * Return the value to pass as `model.baseUrl` to the inner SDK so that,
 * after the SDK appends its own path, we hit the correct endpoint.
 */
export function baseUrlFor(baseUrl: string, api: ApiKind): string {
	const stripped = baseUrl.replace(/\/+$/, "");
	if (api === "anthropic-messages") {
		// Anthropic SDK appends /v1/messages → baseUrl should NOT include /v1.
		return stripped.replace(/\/v1$/, "");
	}
	return stripped;
}
