/**
 * Loads model catalogs from OpenCode Console `/api/config` (org-scoped,
 * device sessions) plus the public `/models` catalogs of the Console
 * (`https://opencode.ai/inference/v1`) and Go (`https://opencode.ai/inference/go/v1`)
 * gateways (Go mode, called with the session's access token), and projects
 * them to pi's `ProviderModelConfig` shape.
 */

import { apiBaseForMode, EXTENSION_API, resolveRoute, type ApiKind, type OpenCodeMode } from "./endpoint.ts";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevelMap } from "@earendil-works/pi-ai/compat";

// Raw shape returned by OpenCode Console `/api/config`.
// Documented in opencode's `packages/core/src/plugin/provider/opencode.ts`.

export interface ModelConfigSource {
	id?: unknown;
	name?: unknown;
	family?: unknown;
	status?: unknown;
	disabled?: unknown;
	reasoning?: unknown;
	modalities?: { input?: unknown };
	attachment?: unknown;
	tool_call?: unknown;
	provider?: { npm?: unknown; api?: unknown };
	reasoning_options?: unknown;
	cost?: { input?: unknown; output?: unknown; cache_read?: unknown; cache_write?: unknown };
	limit?: { context?: unknown; output?: unknown; input?: unknown };
	options?: Record<string, unknown>;
	headers?: Record<string, unknown>;
}

export interface ProviderSource {
	name?: unknown;
	npm?: unknown;
	api?: unknown;
	options?: { headers?: Record<string, unknown> };
	models?: Record<string, ModelConfigSource>;
	[key: string]: unknown;
}

function num(v: unknown, fallback: number): number {
	return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function stringField(obj: Record<string, unknown> | undefined, key: string): string | undefined {
	const v = obj?.[key];
	return typeof v === "string" ? v : undefined;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
	if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
	return undefined;
}

function imageCapable(source: ModelConfigSource): boolean {
	const inputs = source.modalities?.input;
	if (Array.isArray(inputs) && inputs.includes("image")) return true;
	return source.attachment === true;
}

function stringHeaders(record: Record<string, unknown> | undefined): Record<string, string> | undefined {
	if (!record) return undefined;
	const out: Record<string, string> = {};
	let any = false;
	for (const [k, v] of Object.entries(record)) {
		if (typeof v === "string") {
			out[k] = v;
			any = true;
		}
	}
	return any ? out : undefined;
}

export async function loadConsoleConfig(
	server: string,
	token: string,
	orgId: string,
	fetcher: typeof fetch = fetch,
	signal?: AbortSignal,
): Promise<Map<string, ProviderSource>> {
	const baseUrl = server.replace(/\/+$/, "");
	const response = await fetcher(`${baseUrl}/api/config`, {
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${token}`,
			"x-org-id": orgId,
		},
		signal,
	});
	if (response.status === 404) {
		throw new Error("This OpenCode Console server does not expose organization configuration");
	}
	if (!response.ok) {
		throw new Error(`OpenCode Console model configuration failed (${response.status})`);
	}
	const json = (await response.json()) as { config?: { provider?: Record<string, ProviderSource> } };
	const providers = json.config?.provider ?? {};
	return new Map(Object.entries(providers));
}

export interface BuiltModel {
	id: string;
	/** Raw upstream model id, before duplicate disambiguation. */
	wireId: string;
	name: string;
	provider: string;
	/** pi-level API kind — always the registered extension api so the
	 * provider composer routes every model through our streamSimple wrapper. */
	api: typeof EXTENSION_API;
	/** Real gateway route (wire API) for this model. */
	route: ApiKind;
	baseUrl: string;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	input: ("text" | "image")[];
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
	headers?: Record<string, string>;
	thinkingLevelMap?: ThinkingLevelMap;
	compat?: { forceAdaptiveThinking?: boolean };
}

/**
 * models.dev catalog snapshot — public metadata for the `opencode`
 * (Console gateway, `full` list) and `opencode-go` (`lite` list)
 * providers, used to fill limits/cost/pricing that the live `/models`
 * rows omit. Ported from the sister project's metadata module.
 */
const MODELS_DEV_API_URL = "https://models.dev/api.json";
const MODELS_DEV_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const MODELS_DEV_TIMEOUT_MS = 15_000;

function modelsDevProviderId(mode: OpenCodeMode): string {
	return mode === "go" ? "opencode-go" : "opencode";
}

/**
 * Models served by OpenCode discovery before models.dev catalogs them. Each
 * entry mirrors the closest sibling's published facts, is only used when
 * models.dev lacks the id, and is superseded by the canonical entry once it
 * lands upstream. Ported verbatim from the sister project (synced 2026-10).
 */
const SUPPLEMENTAL_MODELS: Readonly<Record<"opencode" | "opencode-go", Readonly<Record<string, ModelConfigSource>>>> = {
	// Console currently has no supplemental entries: jev ids were removed —
	// they are System One decision-protocol models (models.dev lists them
	// with output limit 0, structured-only, no tool call), unable to serve
	// chat text; pi's own official config excludes them entirely.
	opencode: {},
	"opencode-go": {
		"hy3-preview": {
			id: "hy3-preview",
			name: "Hy3 preview",
			family: "Hy",
			limit: { context: 256_000, input: 192_000, output: 128_000 },
			reasoning: true,
			tool_call: true,
			modalities: { input: ["text"] },
			reasoning_options: [{ type: "effort", values: ["none", "low", "high"] }],
		},
		"deepseek-flash": {
			id: "deepseek-flash",
			name: "DeepSeek V4.1 Flash",
			family: "deepseek-flash",
			limit: { context: 1_000_000, output: 384_000 },
			reasoning: true,
			reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }],
			tool_call: true,
			attachment: true,
			modalities: { input: ["text", "image"] },
			cost: { input: 0.15, output: 0.6, cache_read: 0.003 },
		},
		"minimax-m2.5": {
			id: "minimax-m2.5",
			name: "MiniMax-M2.5",
			family: "minimax",
			limit: { context: 204_800, output: 131_072 },
			reasoning: true,
			reasoning_options: [],
			tool_call: true,
			modalities: { input: ["text"] },
			cost: { input: 0.3, output: 1.2, cache_read: 0.06 },
		},
		"kimi-k2.5": {
			id: "kimi-k2.5",
			name: "Kimi K2.5",
			family: "kimi-k2",
			limit: { context: 262_144, output: 65_536 },
			reasoning: true,
			reasoning_options: [{ type: "toggle" }],
			tool_call: true,
			attachment: true,
			modalities: { input: ["text", "image", "video"] },
			cost: { input: 0.6, output: 3, cache_read: 0.08 },
		},
		"glm-5.1": {
			id: "glm-5.1",
			name: "GLM-5.1",
			family: "glm",
			limit: { context: 204_800, output: 131_072 },
			reasoning: true,
			reasoning_options: [{ type: "toggle" }],
			tool_call: true,
			modalities: { input: ["text"] },
			cost: { input: 1.4, output: 4.4, cache_read: 0.26 },
		},
		"glm-5": {
			id: "glm-5",
			name: "GLM-5",
			family: "glm",
			limit: { context: 204_800, output: 131_072 },
			reasoning: true,
			reasoning_options: [{ type: "toggle" }],
			tool_call: true,
			modalities: { input: ["text"] },
			cost: { input: 1, output: 3.2, cache_read: 0.2 },
		},
		"qwen3.5-plus": {
			id: "qwen3.5-plus",
			name: "Qwen3.5 Plus",
			family: "qwen3.5",
			limit: { context: 262_144, output: 65_536 },
			reasoning: true,
			reasoning_options: [{ type: "toggle" }, { type: "budget_tokens", max: 81_920 }],
			tool_call: true,
			attachment: true,
			modalities: { input: ["text", "image", "video"] },
			provider: { npm: "@ai-sdk/anthropic" },
			cost: { input: 0.2, output: 1.2, cache_read: 0.02 },
		},
		"mimo-v2-pro": {
			id: "mimo-v2-pro",
			name: "MiMo-V2-Pro",
			family: "mimo",
			limit: { context: 1_048_576, output: 131_072 },
			reasoning: true,
			reasoning_options: [{ type: "toggle" }],
			tool_call: true,
			modalities: { input: ["text"] },
		},
		"mimo-v2-omni": {
			id: "mimo-v2-omni",
			name: "MiMo-V2-Omni",
			family: "mimo",
			limit: { context: 262_144, output: 131_072 },
			reasoning: true,
			reasoning_options: [{ type: "toggle" }],
			tool_call: true,
			attachment: true,
			modalities: { input: ["text", "image", "audio", "video", "pdf"] },
		},
		"omen-alpha": {
			id: "omen-alpha",
			name: "Omen Alpha",
			family: "omen",
			limit: { context: 262_144, output: 65_536 },
			reasoning: true,
			reasoning_options: [{ type: "toggle" }],
			tool_call: true,
			attachment: true,
			modalities: { input: ["text", "image"] },
		},
	},
};

/**
 * Live discovery may serve a legacy alias id alongside the canonical id for
 * the same model. When both appear in one discovery response the alias is
 * hidden; if only the alias is served it keeps its supplemental metadata.
 */
const ALIAS_MODELS: Readonly<Record<"opencode" | "opencode-go", Readonly<Record<string, string>>>> = {
	opencode: {},
	"opencode-go": { "deepseek-flash": "deepseek-v4.1-flash" },
};

/** In-process snapshot cache (6h TTL) so repeated refreshes skip the ~5MB fetch. */
interface ModelsDevSnapshot {
	fetchedAt: number;
	npm?: string;
	models: Record<string, ModelConfigSource>;
}
let modelsDevCache: Partial<Record<"opencode" | "opencode-go", ModelsDevSnapshot>> | undefined;

/** @internal Test hook: drops the in-process models.dev snapshot cache. */
export function resetModelsDevCacheForTests(): void {
	modelsDevCache = undefined;
}

async function fetchModelsDevProvider(
	mode: OpenCodeMode,
	fetcher: typeof fetch,
	signal?: AbortSignal,
): Promise<ModelsDevSnapshot | undefined> {
	const devId = modelsDevProviderId(mode) as "opencode" | "opencode-go";
	const cached = modelsDevCache?.[devId];
	if (cached && Date.now() - cached.fetchedAt < MODELS_DEV_CACHE_TTL_MS) return cached;
	try {
		const timeout = typeof AbortSignal.timeout === "function" && !signal ? AbortSignal.timeout(MODELS_DEV_TIMEOUT_MS) : undefined;
		const response = await fetcher(MODELS_DEV_API_URL, {
			headers: { Accept: "application/json" },
			signal: signal ?? timeout,
		});
		if (!response.ok) return cached;
		const providers = (await response.json()) as Record<string, { npm?: unknown; models?: Record<string, ModelConfigSource> }>;
		// Supplemental discovery-only ids are inserted first; actual
		// models.dev entries overwrite same-key supplements so the canonical
		// entry supersedes once it lands upstream.
		const models: Record<string, ModelConfigSource> = { ...SUPPLEMENTAL_MODELS[devId] };
		const raw = providers[devId];
		for (const [key, value] of Object.entries(asRecord(raw?.models) ?? {})) {
			models[key] = value as ModelConfigSource;
		}
		const snapshot: ModelsDevSnapshot = {
			fetchedAt: Date.now(),
			npm: typeof raw?.npm === "string" ? raw.npm : undefined,
			models,
		};
		modelsDevCache = { ...(modelsDevCache ?? {}), [devId]: snapshot };
		return snapshot;
	} catch {
		// Enrichment must never break discovery; fall back to a stale snapshot.
		return cached;
	}
}

/** Merge models.dev metadata under the live row: live values win per field. */
function fillFromModelsDev(live: ModelConfigSource, dev?: ModelConfigSource): ModelConfigSource {
	if (!dev) return live;
	return {
		...dev,
		...live,
		limit: { ...(dev.limit ?? {}), ...(live.limit ?? {}) },
		cost: { ...(dev.cost ?? {}), ...(live.cost ?? {}) },
		modalities: { ...(dev.modalities ?? {}), ...(live.modalities ?? {}) },
		attachment: live.attachment ?? dev.attachment,
		tool_call: live.tool_call ?? dev.tool_call,
		reasoning: live.reasoning ?? dev.reasoning,
		provider: { ...(asRecord(dev.provider) ?? {}), ...(asRecord(live.provider) ?? {}) } as ModelConfigSource["provider"],
		options: { ...(dev.options ?? {}), ...(live.options ?? {}) },
	};
}

/**
 * Fetch the `/models` catalog rows for a gateway mode
 * (`https://opencode.ai/inference/v1/models` Console `full`, or
 * `https://opencode.ai/inference/go/v1/models` Go `lite`, auth-ignored).
 * Without a token the catalog is fully public; with one it is Bearer-authed
 * (workspace-disabled models are filtered server-side). Payload shape:
 * `{ data: [ModelSource-like rows] }` with string-only ids permitted.
 *
 * This is the discovery-only half: no models.dev enrichment runs here, so
 * the caller can publish a first-pass catalog immediately and enrich after.
 * Throws on non-200 responses.
 */
export async function fetchPublicModelsRows(
	mode: OpenCodeMode,
	token: string | undefined,
	fetcher: typeof fetch = fetch,
	signal?: AbortSignal,
): Promise<ModelConfigSource[]> {
	const base = apiBaseForMode(mode);
	const headers: Record<string, string> = { Accept: "application/json" };
	if (token) headers.Authorization = `Bearer ${token}`;
	const response = await fetcher(`${base}/models`, { headers, signal });
	if (!response.ok) {
		throw new Error(`OpenCode ${mode} model discovery failed (${response.status})`);
	}
	const payload = (await response.json()) as { data?: unknown[] };
	const rows: ModelConfigSource[] = [];
	for (const item of payload.data ?? []) {
		const row = asRecord(item);
		const id = typeof row?.id === "string" && row.id ? row.id : typeof item === "string" && item ? item : undefined;
		if (!id) continue;
		const live: ModelConfigSource = row ?? { id };
		rows.push({ ...live, id });
	}
	return rows;
}

export interface PublicModelsSnapshot {
	npm?: string;
	models: Record<string, ModelConfigSource>;
}

/**
 * The models.dev snapshot for a mode (supplemental discovery-only ids
 * merged under real upstream entries). Network is skipped when the
 * in-process cache is fresh; failures return the last cached snapshot.
 */
export async function getModelsDevSnapshot(
	mode: OpenCodeMode,
	fetcher: typeof fetch = fetch,
	signal?: AbortSignal,
): Promise<PublicModelsSnapshot | undefined> {
	return fetchModelsDevProvider(mode, fetcher, signal);
}

/**
 * Compose the single-source provider map for `buildPiModels` projection
 * from `/models` rows. Metadata resolution per id: models.dev, then the
 * bundled supplemental mirror (only when models.dev lacks the id), merged
 * under the live row — live values always win per field.
 */
export function buildProviderSources(
	mode: OpenCodeMode,
	rows: readonly ModelConfigSource[],
	dev?: PublicModelsSnapshot,
): Map<string, ProviderSource> {
	const devId = modelsDevProviderId(mode) as "opencode" | "opencode-go";
	const models: Record<string, ModelConfigSource> = {};
	for (const row of rows) {
		const id = row.id as string;
		const reference = dev?.models?.[id] ?? SUPPLEMENTAL_MODELS[devId][id];
		models[id] = fillFromModelsDev(row, reference);
	}
	// Hide a legacy alias id when its canonical id is served alongside it.
	for (const [alias, canonical] of Object.entries(ALIAS_MODELS[devId])) {
		if (alias in models && canonical in models) delete models[alias];
	}
	const providerId = modelsDevProviderId(mode);
	return new Map([[providerId, { name: providerId, api: apiBaseForMode(mode), npm: dev?.npm, models } as ProviderSource]]);
}

/**
 * Load the composed public (or workspace-scoped) `/models` catalog for a
 * gateway mode. Convenience wrapper around `fetchPublicModelsRows` +
 * `getModelsDevSnapshot` + `buildProviderSources`.
 */
export async function loadPublicModels(
	mode: OpenCodeMode,
	token: string | undefined,
	fetcher: typeof fetch = fetch,
	signal?: AbortSignal,
): Promise<Map<string, ProviderSource>> {
	const rows = await fetchPublicModelsRows(mode, token, fetcher, signal);
	const devModels = await fetchModelsDevProvider(mode, fetcher, signal);
	return buildProviderSources(mode, rows, devModels);
}

/**
 * Bundled fallback ids for the Go subscription gateway (`lite` list),
 * snapshotted from `https://opencode.ai/inference/go/v1/models` on
 * 2026-10-20. Live discovery always replaces them; they only surface when
 * `/models` is unreachable and no persisted catalog exists yet, so the
 * provider still offers an offline-ready picker list (metadata Poverty:
 * models.dev/supplemental fills what it can, defaults otherwise).
 */
export const GO_FALLBACK_MODEL_IDS: readonly string[] = [
	"beam-free",
	"claude-haiku-5-5",
	"deepseek-v4-pro",
	"deepseek-v4.1-flash",
	"gemini-4-argon-contributor",
	"glm-5.1",
	"glm-5.2",
	"glm-5.3",
	"glm-5.3-flash",
	"gpt-5.6-luna",
	"gpt-6-luna",
	"grok-4.6",
	"grok-4.7",
	"hy3",
	"hy4-preview",
	"kimi-k2.6",
	"kimi-k2.7-code",
	"kimi-k3",
	"longcat-2.0",
	"longcat-2.5-preview-free",
	"mimo-v2.5",
	"mimo-v2.5-pro",
	"mimo-v2.6-flash",
	"mimo-v2.6-pro",
	"minimax-m2.5",
	"minimax-m2.7",
	"minimax-m3",
	"minimax-m3.1-flash-free",
	"muse-spark-1.2-contributor",
	"muse-spark-1.3-contributor",
	"omen-alpha",
	"qwen3.6-plus",
	"qwen3.7-max",
	"qwen3.7-plus",
	"qwen3.8-flash",
	"qwen3.8-max",
	"step-5-preview",
];

/** Go fallback rows in `ModelConfigSource` shape (bare ids). */
export const GO_FALLBACK_MODELS: readonly ModelConfigSource[] = GO_FALLBACK_MODEL_IDS.map((id) => ({ id }));

/**
 * Map a model's `reasoning_options` effort values onto pi's thinking-level
 * map: supported pi levels keep their wire value; unsupported ones are
 * explicitly `null` so pi's level clamping picks the nearest supported
 * effort instead of sending a value the gateway rejects. Toggle- and
 * budget-type options are not mapped (pi handles on/off itself).
 */
function deriveThinkingLevelMap(options: unknown): ThinkingLevelMap | undefined {
	if (!Array.isArray(options)) return undefined;
	let values: Set<string> | undefined;
	for (const item of options) {
		const spec = asRecord(item);
		if (typeof spec?.type === "string" && spec.type.toLowerCase() === "effort" && Array.isArray(spec.values)) {
			const strs = spec.values.filter((v): v is string => typeof v === "string" && Boolean(v.trim())).map((v) => v.trim().toLowerCase());
			if (strs.length) {
				values = new Set(strs);
				break;
			}
		}
	}
	if (!values) return undefined;
	const LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
	const map: ThinkingLevelMap = {};
	for (const level of LEVELS) {
		map[level] = values.has(level) ? level : null;
	}
	return map;
}

export function buildPiModels(providers: Map<string, ProviderSource>, mode: OpenCodeMode = "console"): BuiltModel[] {
	// First pass: collect entries and a list of (providerId, rawId) pairs.
	const entries: BuiltModel[] = [];
	const ownerByModelId = new Map<string, string[]>();

	for (const [providerId, provider] of providers) {
		for (const [rawId, source] of Object.entries(provider.models ?? {})) {
			if (source.status === "deprecated" || source.disabled === true) continue;
			// Internal OpenCode smoke-test ids leak into authenticated
			// discovery; they are never real picker entries (sibling parity).
			if (/^test(?:[-_.]|$)/i.test(rawId.trim())) continue;
			// Jev ids run the System One decision protocol (structured
			// choices/scores, no text generation): they cannot serve chat and
			// pi's official config omits them (models.dev: output limit 0).
			if (/^jev(?:-|$)/i.test(rawId.trim())) continue;
			const modelId = typeof source.id === "string" ? source.id : rawId;
			const api = resolveRoute(modelId, stringField(asRecord(source.provider), "npm") ?? stringField(provider, "npm"), mode);
			const baseUrl = stringField(asRecord(source.provider), "api") ?? stringField(provider, "api") ?? "";
			if (!baseUrl) continue; // can't route without a base URL
			const context = num(source.limit?.context, 32_768);
			const output = num(source.limit?.output, Math.min(context, 8_192));
			const providerHeaders = stringHeaders(provider.options?.headers);
			const modelHeaders = stringHeaders(source.headers);
			const mergedHeaders = providerHeaders || modelHeaders
				? { ...(providerHeaders ?? {}), ...(modelHeaders ?? {}) }
				: undefined;
			const thinkingLevelMap = deriveThinkingLevelMap(source.reasoning_options);
			// Live-verified (2026-10-12): the gateway rejects `thinking:
			// {type: "disabled"}` for adaptive-thinking Claude models ("use
			// thinking.type.adaptive and output_config.effort"). Sister parity
			// (opencode-copilot-chat #63): "off" omits the thinking field entirely;
			// enabled = adaptive + effort. pi-ai omits the field only when
			// thinkingLevelMap.off === null and sends adaptive only under
			// compat.forceAdaptiveThinking — provide both when the catalog gives
			// no reasoning_options for a reasoning-capable Claude model.
			const isAdaptiveClaude =
				api === "anthropic-messages" && /^claude-/i.test(modelId) && source.reasoning === true;
			const thinking = thinkingLevelMap
				? { thinkingLevelMap }
				: isAdaptiveClaude
					? {
						thinkingLevelMap: {
							off: null,
							minimal: "low",
							low: "low",
							medium: "medium",
							high: "high",
							xhigh: "xhigh",
							max: "max",
						},
						compat: { forceAdaptiveThinking: true },
					}
					: {};
			entries.push({
				id: rawId,
				wireId: rawId,
				name: typeof source.name === "string" ? source.name : rawId,
				provider: providerId,
				api: EXTENSION_API,
				route: api,
				baseUrl,
				contextWindow: context,
				maxTokens: output,
				reasoning: source.reasoning === true,
				...thinking,
				input: imageCapable(source) ? ["text", "image"] : ["text"],
				cost: {
					input: num(source.cost?.input, 0),
					output: num(source.cost?.output, 0),
					cacheRead: num(source.cost?.cache_read, 0),
					cacheWrite: num(source.cost?.cache_write, 0),
				},
				headers: mergedHeaders,
			});
			const owners = ownerByModelId.get(rawId) ?? [];
			owners.push(providerId);
			ownerByModelId.set(rawId, owners);
		}
	}

	// Disambiguate duplicate raw ids by prefixing with providerId.
	const duplicateIds = new Set<string>();
	for (const [id, owners] of ownerByModelId) {
		if (owners.length > 1) duplicateIds.add(id);
	}
	if (duplicateIds.size === 0) return entries;

	// Build an index entry(rawId) -> providerId using insertion order so
	// disambiguation is deterministic.
	const providerForRawId = new Map<string, string>();
	for (const [rawId, owners] of ownerByModelId) {
		if (owners.length === 1) {
			providerForRawId.set(rawId, owners[0]!);
		}
	}
	// Now walk again, picking the provider that owns the entry.
	return entries.map((e) => {
		if (!duplicateIds.has(e.id)) return e;
		const owners = ownerByModelId.get(e.id) ?? [];
		// Pick by baseUrl match against the owning provider's api url.
		const ownerProvider = owners.find((pid) => {
			const provider = providers.get(pid);
			const api = stringField(asRecord(provider?.models?.[e.id]?.provider), "api") ?? stringField(provider, "api");
			return api === e.baseUrl;
		}) ?? owners[0]!;
		void providerForRawId;
		return { ...e, id: `${ownerProvider}/${e.id}` };
	});
}

/**
 * Convert BuiltModel entries to pi's `ProviderModelConfig` shape.
 */
export function toProviderModelConfigs(entries: BuiltModel[]): ProviderModelConfig[] {
	return entries.map((m) => ({
		id: m.id,
		name: m.name,
		api: m.api as ApiKind & ProviderModelConfig["api"],
		baseUrl: m.baseUrl,
		contextWindow: m.contextWindow,
		maxTokens: m.maxTokens,
		reasoning: m.reasoning,
		input: m.input,
		cost: m.cost,
		// `wireId`/`wireApi` are not part of pi's ProviderModelConfig type, but
		// the runtime preserves unknown fields on extension models, so they
		// reach `streamConsole` where they drive wire id + gateway routing.
		wireId: m.wireId,
		wireApi: m.route,
		...(m.headers ? { headers: m.headers } : {}),
		...(m.thinkingLevelMap ? { thinkingLevelMap: m.thinkingLevelMap } : {}),
		...(m.compat ? { compat: m.compat } : {}),
	})) as unknown as ProviderModelConfig[];
}
