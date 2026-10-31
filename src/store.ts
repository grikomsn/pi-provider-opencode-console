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

interface PersistedProviderEntry {
	models?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The catalog pi persisted for `providerId`, or an empty list when nothing has
 * been discovered yet (no store, unreadable store, or no entry for that id).
 * Rows come from pi's own publication, so they already carry the `api` and
 * `baseUrl` pi's provider composer needs at registration time; a persisted row
 * without a usable `id` or `baseUrl` is dropped rather than left to throw
 * during `registerProvider` (which would fail the whole extension load).
 */
export function readPersistedProviderModels(providerId: string): ProviderModelConfig[] {
	try {
		const raw = readFileSync(join(getAgentDir(), "models-store.json"), "utf8");
		const store: unknown = JSON.parse(raw);
		if (!isRecord(store) || !isRecord(store[providerId])) return [];
		const entry = store[providerId] as PersistedProviderEntry;
		if (!Array.isArray(entry.models)) return [];
		return entry.models.filter(
			(model): model is ProviderModelConfig =>
				isRecord(model) &&
				typeof model.id === "string" &&
				typeof model.baseUrl === "string",
		);
	} catch {
		return [];
	}
}
