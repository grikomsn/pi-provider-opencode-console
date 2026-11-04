import test from "node:test";
import assert from "node:assert/strict";

import { readPersistedProviderModels, usablePersistedModels } from "../src/store.ts";
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

test("reads a store that starts with a byte-order mark, as pi's own reader does", async () => {
	await withAgentDir(`\uFEFF${JSON.stringify({ "opencode-go-console": { models: [goRow] } })}`, () => {
		assert.deepEqual(readPersistedProviderModels("opencode-go-console"), [goRow]);
	});
});

test("returns [] for a store whose root is not an object", async () => {
	await withAgentDir("[]", () => {
		assert.deepEqual(readPersistedProviderModels("opencode-go-console"), []);
	});
});

test("drops rows whose api or baseUrl would make pi's registration throw", async () => {
	const corrupt = [
		{ ...goRow, id: "api-empty", api: "" },
		{ ...goRow, id: "api-blank", api: "  " },
		{ ...goRow, id: "api-number", api: 7 },
		{ ...goRow, id: "base-empty", baseUrl: "" },
		{ ...goRow, id: "base-blank", baseUrl: " " },
		{ ...goRow, id: "base-null", baseUrl: null },
		{ ...goRow, id: "" },
		{ ...goRow, id: "   " },
	];
	await withAgentDir({ "opencode-go-console": { models: [...corrupt, goRow] } }, () => {
		assert.deepEqual(readPersistedProviderModels("opencode-go-console"), [goRow]);
	});
});

test("keeps rows that defer their api to the provider", () => {
	const { api: _api, ...noApi } = goRow;
	const nullApi = { ...goRow, api: null };
	assert.deepEqual(usablePersistedModels([noApi, nullApi]), [noApi, nullApi]);
});

test("keeps only chat rows", () => {
	const chat = { ...goRow, type: "chat" };
	const image = { ...goRow, id: "img", type: "image" };
	assert.deepEqual(usablePersistedModels([chat, image, goRow]), [chat, goRow]);
});

test("usablePersistedModels tolerates a missing or non-array model list", () => {
	assert.deepEqual(usablePersistedModels(undefined), []);
	assert.deepEqual(usablePersistedModels({ id: "x" }), []);
});
