/**
 * Reads pi's persisted provider catalogs (`<agentDir>/models-store.json`).
 *
 * Pi snapshots each discovered catalog there and only re-serves it on an
 * asynchronous refresh pass, so the registered provider starts empty until
 * that pass lands. Pi resolves the startup model (`defaultProvider` /
 * `defaultModel`) before then and silently falls back to another configured
 * provider's default when the lookup misses, so the persisted catalog is
 * registered up front instead of waiting for the first refresh.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

type ChatModelConfig = Extract<ProviderModelConfig, { type?: "chat" }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
	typeof value === "string" && value.trim().length > 0;

/**
 * The persisted rows that are safe to hand to pi. Pi validates extension
 * models inside `registerProvider` and again whenever a refresh publishes: it
 * resolves `row.api ?? provider.api` and `row.baseUrl ?? provider.baseUrl`, and
 * throws when the result is empty — which fails the whole extension load, or
 * every refresh. Both providers here register a provider-level `api` but no
 * provider-level `baseUrl`, so a row keeps its place only when it is a chat
 * row with a non-empty string `id` and `baseUrl`, and an `api` that is either
 * absent (`undefined`/`null`, deferring to the provider) or a non-empty string.
 */
export function usablePersistedModels(models: unknown): ChatModelConfig[] {
	if (!Array.isArray(models)) return [];
	return models.filter(
		(model): model is ChatModelConfig =>
			isRecord(model) &&
			isNonEmptyString(model.id) &&
			(model.type === undefined || model.type === "chat") &&
			(model.api === undefined || model.api === null || isNonEmptyString(model.api)) &&
			isNonEmptyString(model.baseUrl),
	);
}

/**
 * The catalog pi persisted for `providerId`, or an empty list when nothing
 * usable has been discovered yet (no store, unreadable or malformed store, no
 * entry for that id, or no usable rows). Never throws: this runs inside the
 * extension factory. A leading byte-order mark is stripped, as pi's own reader
 * does.
 */
export function readPersistedProviderModels(providerId: string): ChatModelConfig[] {
	try {
		const raw = readFileSync(join(getAgentDir(), "models-store.json"), "utf8");
		const store: unknown = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
		if (!isRecord(store)) return [];
		const entry = store[providerId];
		return isRecord(entry) ? usablePersistedModels(entry.models) : [];
	} catch {
		return [];
	}
}
