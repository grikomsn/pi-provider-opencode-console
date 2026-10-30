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
import { homedir } from "node:os";
import { join } from "node:path";

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";

/** Match pi's configured agent directory, including isolated environments. */
function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

interface PersistedProviderEntry {
	models?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The catalog pi persisted for `providerId`, or an empty list when nothing has
 * been discovered yet (no store, unreadable store, or no entry for that id).
 * Rows come from pi's own publication, so they already carry the `api` and
 * `baseUrl` pi's provider composer needs at registration time.
 */
export function readPersistedProviderModels(providerId: string): ProviderModelConfig[] {
	try {
		const raw = readFileSync(join(agentDir(), "models-store.json"), "utf8");
		const store: unknown = JSON.parse(raw);
		if (!isRecord(store) || !isRecord(store[providerId])) return [];
		const entry = store[providerId] as PersistedProviderEntry;
		if (!Array.isArray(entry.models)) return [];
		return entry.models.filter((model): model is ProviderModelConfig => isRecord(model) && typeof model.id === "string");
	} catch {
		return [];
	}
}
