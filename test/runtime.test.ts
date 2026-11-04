import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import type { ExtensionAPI, ProviderConfig } from "@earendil-works/pi-coding-agent";

import providerFactory from "../src/index.ts";
import { EXTENSION_API } from "../src/endpoint.ts";
import { withAgentDir } from "./helpers.ts";

/**
 * Registration through pi's real ModelRuntime: `registerProvider` runs pi's
 * extension-provider validation, and the runtime's cache-only refresh runs the
 * provider's own `refreshModels` against the persisted entry. Neither may throw
 * because of a corrupt row in `models-store.json`.
 */

const GO = "opencode-go-console";
const liveOnly = {
	id: "live-only-model",
	name: "Live Only",
	api: "openai-completions",
	baseUrl: "https://opencode.ai/inference/go/openai/v1",
	contextWindow: 128_000,
	maxTokens: 16_000,
};

async function createRuntime() {
	const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
	const dir = process.env.PI_CODING_AGENT_DIR!;
	return ModelRuntime.create({
		authPath: join(dir, "auth.json"),
		modelsPath: join(dir, "models.json"),
		refreshOnCreate: false,
	});
}

function registerWith(runtime: Awaited<ReturnType<typeof createRuntime>>): void {
	providerFactory({
		registerProvider: (name: string, config: ProviderConfig) => runtime.registerProvider(name, config),
		registerCommand() {},
	} as unknown as ExtensionAPI);
}

test("pi resolves a seeded live-only model synchronously after registration", async () => {
	await withAgentDir({ [GO]: { models: [liveOnly], checkedAt: 1 } }, async () => {
		const runtime = await createRuntime();
		registerWith(runtime);
		// Startup model selection reads the runtime before any refresh lands.
		assert.equal(runtime.getModel(GO, liveOnly.id)?.id, liveOnly.id);
		await runtime.refresh({ allowNetwork: false });
		assert.equal(runtime.getModel(GO, liveOnly.id)?.id, liveOnly.id);
	});
});

test("corrupt persisted rows never make pi's registration or cache-only refresh throw", async () => {
	const corrupt = [
		{ ...liveOnly, id: "bad-api-empty", api: "" },
		{ ...liveOnly, id: "bad-api-number", api: 7 },
		{ ...liveOnly, id: "bad-base-empty", baseUrl: "" },
		{ ...liveOnly, id: "bad-base-missing", baseUrl: undefined },
	];
	await withAgentDir({ [GO]: { models: [...corrupt, liveOnly], checkedAt: 1 } }, async () => {
		const runtime = await createRuntime();
		assert.doesNotThrow(() => registerWith(runtime));
		const ids = () => runtime.getModels().filter((model) => model.provider === GO).map((model) => model.id);
		assert.deepEqual(ids(), [liveOnly.id]);
		const result = await runtime.refresh({ allowNetwork: false });
		assert.equal(result.errors.get(GO), undefined);
		assert.deepEqual(ids(), [liveOnly.id]);
	});
});

test("the unfiltered corrupt rows really do break pi's registration (guards the guard)", async () => {
	await withAgentDir(undefined, async () => {
		const runtime = await createRuntime();
		const register = (row: Record<string, unknown>) =>
			runtime.registerProvider(GO, {
				name: "OpenCode Go",
				api: EXTENSION_API,
				models: [{ ...liveOnly, ...row }] as never,
				streamSimple: (() => {
					throw new Error("unused");
				}) as never,
			});
		assert.throws(() => register({ api: "" }), /api/);
		assert.throws(() => register({ baseUrl: "" }), /baseUrl/);
	});
});
