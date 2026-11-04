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
 *   - `google-generative-ai`: use a protocol-specific base (the Google AI SDK expects
 *     the API root, e.g. `/v1beta`, and adds `/models/<id>:
 *     streamGenerateContent` itself).
 * Generic OpenCode catalog bases are first resolved to `/inference` routes;
 * the legacy Go gateway has no Google-compatible inference route.
 */

export type ApiKind =
	| "anthropic-messages"
	| "openai-completions"
	| "openai-responses"
	| "google-generative-ai";

export const OPENCODE_ORIGIN = "https://opencode.ai";
export const OPENCODE_INFERENCE_BASE = `${OPENCODE_ORIGIN}/inference`;
/** Public model-catalog base of the Console gateway. */
export const CONSOLE_API_BASE_URL = `${OPENCODE_INFERENCE_BASE}/v1`;
/** Public model-catalog base of the Go subscription gateway. */
export const GO_API_BASE_URL = `${OPENCODE_INFERENCE_BASE}/go/v1`;

const PROTOCOL_BASE_PATHS: Readonly<Record<ApiKind, string>> = {
	"openai-completions": "openai/v1",
	"openai-responses": "openai/v1",
	"anthropic-messages": "anthropic/v1",
	"google-generative-ai": "google/v1beta",
};

/**
 * `OpenCodeMode` mirrors upstream's two auth systems after the Zen→Console
 * merge: Console and Go authenticate via OAuth device-code sessions on the
 * shared Console device flow. (Workspace `sk-` service-key support was
 * removed in 2.0.)
 */
export type OpenCodeMode = "console" | "go";

/**
 * The API kind every provider registration uses. Built models carry this
 * value in their pi-level `api` field (so pi's provider composer routes ALL
 * of them through our streamSimple wrapper — the composer only delegates to
 * extension streamSimple when `model.api === extension.api`), while the real
 * gateway route travels in the model's `wireApi` field.
 */
export const EXTENSION_API = "openai-completions";

/** Public `/models` catalog base for a mode (console zen `full`, go `lite`). */
export function apiBaseForMode(mode: OpenCodeMode): string {
	return mode === "go" ? GO_API_BASE_URL : CONSOLE_API_BASE_URL;
}

export function resolveRoute(
	modelId: string,
	npm?: string,
	mode: OpenCodeMode = "console",
	baseUrl?: string,
): ApiKind {
	const pkg = (npm ?? "").toLowerCase();
	if (pkg.includes("anthropic")) return "anthropic-messages";
	if (pkg.includes("google")) return "google-generative-ai";
	if (pkg === "@ai-sdk/openai" || pkg.endsWith("/openai")) return "openai-responses";
	// Fallback heuristics by model id.
	if (/^gpt-/i.test(modelId)) return "openai-responses";
	if (/^claude-/i.test(modelId)) return "anthropic-messages";
	// Family fallbacks cover models whose SDK metadata is unavailable.
	if (/^grok(?:-|$)/i.test(modelId)) return "openai-responses";
	if (/^muse-spark-/i.test(modelId)) return "openai-responses";
	// This model uses Completions on Console and Messages on Go.
	if (/^qwen-?3\.8-max$/i.test(modelId)) return mode === "go" ? "anthropic-messages" : "openai-completions";
	if (/^qwen/i.test(modelId)) return "anthropic-messages";
	// MiniMax defaults to Messages on Go and Chat Completions on Console.
	// Explicit model SDK metadata above can override either fallback.
	// The Go catalog base for MiniMax is OpenAI-style: `/openai/v1` serves
	// Chat Completions, while Anthropic Messages would 404 on `/openai/v1/messages`.
	if (mode === "go" && /^minimax-/i.test(modelId)) {
		return baseUrl && isOpenAiKindBase(baseUrl) ? "openai-completions" : "anthropic-messages";
	}
	if (/^gemini-/i.test(modelId)) return "google-generative-ai";
	return "openai-completions";
}

/** True when the catalog base is an OpenAI-protocol base (`.../openai/v1`). */
function isOpenAiKindBase(baseUrl: string): boolean {
	const base = baseUrl.trim().replace(/\/+$/, "");
	if (!base) return false;
	let path = base;
	try { path = new URL(base).pathname.replace(/\/+$/, ""); }
	catch { /* not an absolute URL: compare the raw string */ }
	return /\/openai\/v1$/i.test(path);
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
	const stripped = gatewayBaseUrl(baseUrl, api);
	if (api === "anthropic-messages") {
		// Anthropic SDK appends /v1/messages → baseUrl should NOT include /v1.
		return stripped.replace(/\/v1$/, "");
	}
	return stripped;
}

/** Generic catalog bases are not inference roots for every protocol. */
function gatewayBaseUrl(baseUrl: string, api: ApiKind): string {
	const base = baseUrl.replace(/\/+$/, "");
	let url: URL;
	try { url = new URL(base); }
	catch { return base; }
	if (url.origin !== OPENCODE_ORIGIN || url.username || url.password || url.search || url.hash) return base;
	const gateway = /^\/(?:zen|inference)(\/go)?\/v1$/.exec(url.pathname);
	if (!gateway) return base;
	return `${OPENCODE_INFERENCE_BASE}${gateway[1] ?? ""}/${PROTOCOL_BASE_PATHS[api]}`;
}
