import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readPersistedProviderModels } from "../src/store.ts";

/**
 * Run `fn` with `PI_CODING_AGENT_DIR` pointed at a throwaway agent directory
 * holding `models-store.json` (or nothing, when `store` is omitted).
 */
async function withAgentDir(store: unknown, fn: () => void): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "pi-provider-opencode-console-store-"));
	const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		if (store !== undefined) {
			await mkdir(dir, { recursive: true });
			await writeFile(
				join(dir, "models-store.json"),
				typeof store === "string" ? store : JSON.stringify(store),
			);
		}
		fn();
	} finally {
		if (prevAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = prevAgentDir;
		}
		await rm(dir, { recursive: true, force: true });
	}
}

const goRow = {
	id: "deepseek-v4.1-flash",
	name: "DeepSeek V4.1 Flash",
	api: "openai-completions",
	baseUrl: "https://opencode.ai/inference/go/openai/v1",
	contextWindow: 1000000,
	maxTokens: 384000,
	reasoning: true,
	input: ["text", "image"],
};

test("reads the persisted catalog for a provider", async () => {
	await withAgentDir({ "opencode-go-console": { models: [goRow], checkedAt: 1 } }, () => {
		assert.deepEqual(readPersistedProviderModels("opencode-go-console"), [goRow]);
	});
});

test("returns [] when the provider has no persisted entry", async () => {
	await withAgentDir({ "opencode-console": { models: [] } }, () => {
		assert.deepEqual(readPersistedProviderModels("opencode-go-console"), []);
	});
});

test("returns [] when no store has been written yet", async () => {
	await withAgentDir(undefined, () => {
		assert.deepEqual(readPersistedProviderModels("opencode-go-console"), []);
	});
});

test("returns [] for a malformed store instead of throwing", async () => {
	await withAgentDir("{not json", () => {
		assert.deepEqual(readPersistedProviderModels("opencode-go-console"), []);
	});
});

test("returns [] when the entry does not carry a model list", async () => {
	await withAgentDir({ "opencode-go-console": { checkedAt: 1 } }, () => {
		assert.deepEqual(readPersistedProviderModels("opencode-go-console"), []);
	});
});

test("drops persisted rows without a usable id", async () => {
	await withAgentDir(
		{ "opencode-go-console": { models: [goRow, { name: "no id" }, "junk"] } },
		() => {
			assert.deepEqual(readPersistedProviderModels("opencode-go-console"), [goRow]);
		},
	);
});
