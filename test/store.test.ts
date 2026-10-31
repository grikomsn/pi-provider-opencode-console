import test from "node:test";
import assert from "node:assert/strict";

import { readPersistedProviderModels } from "../src/store.ts";
import { withAgentDir } from "./helpers.ts";

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

test("drops persisted rows without a baseUrl", async () => {
	await withAgentDir(
		{ "opencode-go-console": { models: [goRow, { id: "no-base-url" }, { id: "bad-base-url", baseUrl: 7 }] } },
		() => {
			assert.deepEqual(readPersistedProviderModels("opencode-go-console"), [goRow]);
		},
	);
});
