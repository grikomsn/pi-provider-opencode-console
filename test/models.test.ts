import test from "node:test";
import assert from "node:assert/strict";
import { buildPiModels, loadConsoleConfig, loadPublicModels, resetModelsDevCacheForTests, toProviderModelConfigs, type ProviderSource } from "../src/models.ts";
import { apiBaseForMode, CONSOLE_API_BASE_URL, GO_API_BASE_URL } from "../src/endpoint.ts";

const sampleConfig = {
	config: {
		provider: {
			opencode: {
				api: "https://api.example.test/v1",
				models: {
					"claude-x": {
						name: "Claude X",
						reasoning: false,
						tool_call: true,
						limit: { context: 200_000, output: 8_192 },
						modalities: { input: ["text", "image"] },
						cost: { input: 3, output: 15 },
					},
					"gpt-y": {
						name: "GPT Y",
						reasoning: true,
						limit: { context: 128_000, output: 16_384 },
					},
					"deprecated-z": { status: "deprecated" },
					"disabled-w": { disabled: true },
				},
			},
		},
	},
};

test("loadConsoleConfig sends x-org-id", async () => {
	let requestedHeaders: Record<string, string> | undefined;
	const fetcher: typeof fetch = async (_input, init) => {
		requestedHeaders = Object.fromEntries(new Headers(init?.headers).entries());
		return new Response(JSON.stringify(sampleConfig), { status: 200 });
	};
	const result = await loadConsoleConfig("https://console.example.test", "tok", "org-1", fetcher);
	assert.equal(requestedHeaders!["x-org-id"], "org-1");
	// Headers are normalized to lowercase by the Headers spec.
	assert.equal(requestedHeaders!.authorization, "Bearer tok");
	assert.equal(result.size, 1);
});

test("loadConsoleConfig 404 throws descriptive error", async () => {
	const fetcher: typeof fetch = async () => new Response("", { status: 404 });
	await assert.rejects(
		loadConsoleConfig("https://console.example.test", "t", "o", fetcher),
		/does not expose organization/,
	);
});

test("loadConsoleConfig 500 surfaces status code", async () => {
	const fetcher: typeof fetch = async () => new Response("", { status: 500 });
	await assert.rejects(
		loadConsoleConfig("https://console.example.test", "t", "o", fetcher),
		/500/,
	);
});

test("buildPiModels skips deprecated and disabled", () => {
	const map = new Map(Object.entries(sampleConfig.config.provider));
	const models = buildPiModels(map);
	const ids = models.map((m) => m.id).sort();
	assert.deepEqual(ids, ["claude-x", "gpt-y"]);
});

test("buildPiModels maps reasoning + image input + cost + context", () => {
	const map = new Map(Object.entries(sampleConfig.config.provider));
	const models = buildPiModels(map);
	const claude = models.find((m) => m.id === "claude-x")!;
	assert.equal(claude.reasoning, false);
	assert.deepEqual(claude.input, ["text", "image"]);
	assert.equal(claude.contextWindow, 200_000);
	assert.equal(claude.maxTokens, 8_192);
	assert.equal(claude.cost.input, 3);
	assert.equal(claude.cost.output, 15);
	assert.equal(claude.cost.cacheRead, 0);
	assert.equal(claude.cost.cacheWrite, 0);
	assert.equal(claude.baseUrl, "https://api.example.test/v1");

	const gpt = models.find((m) => m.id === "gpt-y")!;
	assert.equal(gpt.reasoning, true);
	assert.deepEqual(gpt.input, ["text"]);
	assert.equal(gpt.api, "openai-responses");
});

test("buildPiModels uses model-level provider override", () => {
	const config = {
		config: {
			provider: {
				anthropic: {
					api: "https://api.anthropic.com/v1",
					models: {
						"claude-x": {
							name: "Claude X",
							provider: { api: "https://proxy.example.test/v1" },
						},
					},
				},
			},
		},
	};
	const map = new Map(Object.entries(config.config.provider));
	const models = buildPiModels(map);
	assert.equal(models[0].baseUrl, "https://proxy.example.test/v1");
	assert.equal(models[0].api, "anthropic-messages");
});

test("buildPiModels merges provider-level and model-level headers", () => {
	const config = {
		config: {
			provider: {
				opencode: {
					api: "https://api.example.test/v1",
					options: { headers: { "x-provider": "yes" } },
					models: {
						"gpt-y": {
							name: "GPT Y",
							headers: { "x-model": "also" },
						},
					},
				},
			},
		},
	};
	const map = new Map(Object.entries(config.config.provider));
	const models = buildPiModels(map);
	assert.deepEqual(models[0].headers, { "x-provider": "yes", "x-model": "also" });
});

test("buildPiModels disambiguates duplicate raw ids across providers", () => {
	const config = {
		config: {
			provider: {
				anthropic: {
					api: "https://api.anthropic.com/v1",
					models: { shared: { name: "A shared" } },
				},
				openai: {
					api: "https://api.openai.com/v1",
					models: { shared: { name: "O shared" } },
				},
			},
		},
	};
	const map = new Map(Object.entries(config.config.provider));
	const models = buildPiModels(map);
	const ids = models.map((m) => m.id).sort();
	assert.deepEqual(ids, ["anthropic/shared", "openai/shared"]);
	// The disambiguated pi id changes, but the upstream wire id must not.
	assert.deepEqual(models.map((m) => m.wireId).sort(), ["shared", "shared"]);
});

test("buildPiModels skips models without baseUrl", () => {
	const config = {
		config: {
			provider: {
				opencode: {
					// no api at provider level
					models: { missing: { name: "M" } },
				},
			},
		},
	};
	const map = new Map(Object.entries(config.config.provider));
	const models = buildPiModels(map);
	assert.equal(models.length, 0);
});

test("toProviderModelConfigs maps all required fields", () => {
	const map = new Map(Object.entries(sampleConfig.config.provider));
	const models = buildPiModels(map);
	const configs = toProviderModelConfigs(models);
	assert.equal(configs.length, 2);
	for (const c of configs) {
		assert.ok(typeof c.id === "string");
		assert.ok(typeof c.name === "string");
		assert.ok(typeof c.api === "string");
		assert.ok(typeof c.baseUrl === "string");
		assert.ok(typeof c.contextWindow === "number");
		assert.ok(typeof c.maxTokens === "number");
		assert.ok(typeof c.reasoning === "boolean");
		assert.ok(Array.isArray(c.input));
		assert.ok(typeof c.cost === "object");
		assert.ok(typeof (c as { wireId?: unknown }).wireId === "string");
	}
});

// --- public /models catalog (service keys + go mode) ---

const modelsDevPayload = {
	opencode: {
		models: {
			bare: { name: "Bare Filled", reasoning: true, limit: { context: 155_000, output: 32_768 }, cost: { input: 2, output: 8 } },
		},
	},
	"opencode-go": {
		models: {
			"go-model": { name: "Go Filled", limit: { context: 262_144, output: 8_192 } },
		},
	},
};

/** Builds a fetcher that serves the mode gateways and models.dev by URL. */
function routingFetcher(routes: { match: string; response: () => unknown; status?: number }[]) {
	const fetcher: typeof fetch = async (input, init) => {
		const url = String(input);
		for (const route of routes) {
			if (!url.includes(route.match)) continue;
			const json = JSON.stringify(route.response());
			return new Response(json, { status: route.status ?? 200 });
		}
		// Record unexpected URLs, then fail loudly.
		throw new Error(`unexpected fetch URL: ${url}`);
	};
	return fetcher;
}

test("loadPublicModels fetches the Console /models catalog with a Bearer key", async () => {
	let modelsUrl: string | undefined;
	let authHeader: string | undefined;
	const devUrls: string[] = [];
	const fetcher: typeof fetch = async (input, init) => {
		const url = String(input);
		if (url.includes("models.dev")) {
			devUrls.push(url);
			return new Response(JSON.stringify(modelsDevPayload), { status: 200 });
		}
		modelsUrl = url ?? undefined;
		authHeader = new Headers(init?.headers).get("authorization") ?? undefined;
		return new Response(
			JSON.stringify({
				data: [
					{ id: "model-a", name: "A", limit: { context: 400_000, output: 65_536 }, cost: { input: 1, output: 2 } },
					"string-row",
				],
			}),
			{ status: 200 },
		);
	};
	const providers = await loadPublicModels("console", "sk-workspace-key", fetcher);
	assert.equal(modelsUrl, `${CONSOLE_API_BASE_URL}/models`);
	assert.equal(authHeader, "Bearer sk-workspace-key");
	assert.ok(devUrls.every((u) => u.includes("models.dev")));
	const entries = buildPiModels(providers);
	assert.equal(entries.length, 2);
	// The synthetic provider carries the gateway base so string rows resolve.
	assert.equal(entries[1]!.id, "string-row");
	assert.equal(entries[1]!.baseUrl, CONSOLE_API_BASE_URL);
	assert.equal(entries[1]!.api, "openai-completions");
});

test("loadPublicModels targets the Go gateway without optional auth", async () => {
	let modelsUrl: string | undefined;
	let hasAuth = false;
	const fetcher: typeof fetch = async (input, init) => {
		const url = String(input);
		if (url.includes("models.dev")) return new Response(JSON.stringify(modelsDevPayload), { status: 200 });
		modelsUrl = url;
		hasAuth = Boolean(new Headers(init?.headers).get("authorization"));
		void init;
		return new Response(JSON.stringify({ data: [{ id: "go-model", name: "GM" }] }), { status: 200 });
	};
	const providers = await loadPublicModels("go", undefined, fetcher);
	assert.equal(modelsUrl, `${GO_API_BASE_URL}/models`);
	assert.equal(apiBaseForMode("go"), GO_API_BASE_URL);
	assert.equal(hasAuth, false);
	const entries = buildPiModels(providers);
	assert.equal(entries.length, 1);
	// models.dev enrichment fills a bare row from the opencode-go provider.
	assert.equal(entries[0]!.contextWindow, 262_144);
	assert.equal(entries[0]!.maxTokens, 8_192);
	assert.equal(entries[0]!.name, "GM"); // live values win; only missing fields are filled.
});

test("loadPublicModels enriches bare rows and live rows win per field", async () => {
	const fetcher: typeof fetch = async (input) => {
		const url = String(input);
		if (url.includes("models.dev")) return new Response(JSON.stringify(modelsDevPayload), { status: 200 });
		return new Response(
			JSON.stringify({ data: [{ id: "bare", name: "Live Name", limit: { context: 42_000, output: 4_096 } }] }),
			{ status: 200 },
		);
	};
	const providers = await loadPublicModels("console", "sk-k", fetcher);
	const entries = buildPiModels(providers);
	assert.equal(entries.length, 1);
	assert.equal(entries[0]!.name, "Live Name"); // live wins
	assert.equal(entries[0]!.contextWindow, 42_000); // live wins
	assert.equal(entries[0]!.maxTokens, 4_096);
	assert.equal(entries[0]!.cost.input, 2); // filled from models.dev
	assert.equal(entries[0]!.reasoning, true); // filled from models.dev
});

test("loadPublicModels tolerates models.dev failures", async () => {
	const fetcher: typeof fetch = async (input) => {
		const url = String(input);
		if (url.includes("models.dev")) throw new Error("offline");
		return new Response(JSON.stringify({ data: [{ id: "model-a", name: "A" }] }), { status: 200 });
	};
	const providers = await loadPublicModels("console", "sk-k", fetcher);
	const entries = buildPiModels(providers);
	assert.equal(entries.length, 1);
	assert.equal(entries[0]!.name, "A");
});

test("loadPublicModels drops disabled and deprecated rows", async () => {
	const fetcher: typeof fetch = async (input) => {
		const url = String(input);
		if (url.includes("models.dev")) return new Response(JSON.stringify(modelsDevPayload), { status: 200 });
		return new Response(
			JSON.stringify({
				data: [
					{ id: "keep", name: "Keep" },
					{ id: "nope", name: "Nope", disabled: true },
					{ id: "old", name: "Old", status: "deprecated" },
				],
			}),
			{ status: 200 },
		);
	};
	const providers = await loadPublicModels("console", "sk-k", fetcher);
	const entries = buildPiModels(providers);
	assert.deepEqual(entries.map((m) => m.id), ["keep"]);
});

test("loadPublicModels per-row provider.api overrides routing", async () => {
	const fetcher: typeof fetch = async (input) => {
		const url = String(input);
		if (url.includes("models.dev")) return new Response(JSON.stringify(modelsDevPayload), { status: 200 });
		return new Response(
			JSON.stringify({
				data: [{ id: "special", name: "S", provider: { npm: "@anthropic-ai/sdk", api: "https://api.example.test/v1" } }],
			}),
			{ status: 200 },
		);
	};
	const providers = await loadPublicModels("console", "sk-k", fetcher);
	const entries = buildPiModels(providers);
	assert.equal(entries[0]!.baseUrl, "https://api.example.test/v1");
	assert.equal(entries[0]!.api, "anthropic-messages");
});

test("loadPublicModels non-200 throws", async () => {
	const fetcher = routingFetcher([{ match: "/models", response: () => ({}), status: 500 }]);
	await assert.rejects(loadPublicModels("console", "sk-k", fetcher), /failed \(500\)/);
});

// --- sibling ports: smoke-test ids, supplemental metadata, alias dedup, thinking maps ---

test("buildPiModels drops internal test ids", () => {
	const providers = new Map([[
		"opencode",
		{
			api: "https://gateway.example.test/v1",
			models: {
				"real-model": { name: "Real" },
				"test": { name: "Test" },
				"test-smoke": { name: "Test Smoke" },
				"test_2": { name: "Test 2" },
				"testing-9": { name: "Testing 9" }, // "test" prefix without boundary — kept
			},
		} as ProviderSource,
	]]);
	const models = buildPiModels(providers);
	assert.deepEqual(models.map((m) => m.id).sort(), ["real-model", "testing-9"]);
});

test("supplemental metadata fills discovery-only ids before models.dev catalogs them", async () => {
	resetModelsDevCacheForTests();
	const fetcher: typeof fetch = async (input) => {
		const url = String(input);
		// models.dev has no opencode model rows in this fixture.
		if (url.includes("models.dev")) return new Response(JSON.stringify({ opencode: {} }), { status: 200 });
		return new Response(
			JSON.stringify({ data: [{ id: "jev-1.13" }] }), // bare live row
			{ status: 200 },
		);
	};
	const providers = await loadPublicModels("console", "sk-k", fetcher);
	const entries = buildPiModels(providers, "console");
	assert.equal(entries.length, 1);
	const entry = entries[0]!;
	// Ported supplemental facts (mirrored from the closest sibling).
	assert.equal(entry.name, "Jev 1.13");
	assert.equal(entry.contextWindow, 262_144);
	assert.equal(entry.maxTokens, 131_072);
	assert.equal(entry.reasoning, true);
	assert.deepEqual(entry.thinkingLevelMap, { minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" });
});

test("canonical models.dev entries supersede supplemental mirrors", async () => {
	resetModelsDevCacheForTests();
	const fetcher: typeof fetch = async (input) => {
		const url = String(input);
		if (url.includes("models.dev")) {
			return new Response(JSON.stringify({
				opencode: { npm: "@ai-sdk/openai-compatible", models: { "jev-1.13": { name: "Jev (canonical)", limit: { context: 999 } } } },
			}), { status: 200 });
		}
		return new Response(JSON.stringify({ data: [{ id: "jev-1.13" }] }), { status: 200 });
	};
	const providers = await loadPublicModels("console", "sk-k", fetcher);
	const entries = buildPiModels(providers, "console");
	const entry = entries[0]!;
	assert.equal(entry.name, "Jev (canonical)"); // canonical wins
	assert.equal(entry.contextWindow, 999); // canonical wins (live row sparse)
});

test("legacy alias ids are hidden when the canonical id is served alongside", async () => {
	const fetcher: typeof fetch = async (input) => {
		const url = String(input);
		if (url.includes("models.dev")) return new Response(JSON.stringify({}), { status: 200 });
		return new Response(
			JSON.stringify({ data: [{ id: "deepseek-flash" }, { id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" }] }),
			{ status: 200 },
		);
	};
	const providers = await loadPublicModels("go", "sk-k", fetcher);
	const entries = buildPiModels(providers, "go");
	assert.deepEqual(entries.map((m) => m.id), ["deepseek-v4.1-flash"]);
});

test("alias-only discovery keeps its supplemental metadata", async () => {
	resetModelsDevCacheForTests();
	const fetcher: typeof fetch = async (input) => {
		const url = String(input);
		if (url.includes("models.dev")) return new Response(JSON.stringify({}), { status: 200 });
		return new Response(JSON.stringify({ data: [{ id: "deepseek-flash" }] }), { status: 200 });
	};
	const providers = await loadPublicModels("go", "sk-k", fetcher);
	const entries = buildPiModels(providers, "go");
	const entry = entries[0]!;
	assert.equal(entry.id, "deepseek-flash");
	assert.equal(entry.name, "DeepSeek V4.1 Flash");
	assert.equal(entry.contextWindow, 1_000_000);
	assert.equal(entry.cost.input, 0.15);
});

test("reasoning_options map to pi thinking levels; toggle-only models get none", () => {
	const providers = new Map([[
		"opencode-go",
		{
			api: "https://gateway.example.test/go/v1",
			models: {
				"qwen3.5-plus": { reasoning: true, reasoning_options: [{ type: "toggle" }, { type: "budget_tokens", max: 81920 }] },
				"minimax-m3": { reasoning: true, reasoning_options: [] },
			},
		} as unknown as ProviderSource,
	]]);
	const models = buildPiModels(providers, "go");
	assert.equal(models[0]!.id, "qwen3.5-plus");
	assert.equal(models[0]!.thinkingLevelMap, undefined); // toggle/budget only
	assert.equal(models[1]!.thinkingLevelMap, undefined);
});

test("models.dev snapshot is cached within the TTL (one fetch across refreshes)", async () => {
	resetModelsDevCacheForTests();
	let devFetches = 0;
	const fetcher: typeof fetch = async (input) => {
		const url = String(input);
		if (url.includes("models.dev")) {
			devFetches++;
			return new Response(JSON.stringify({}), { status: 200 });
		}
		return new Response(JSON.stringify({ data: [{ id: "m-1" }] }), { status: 200 });
	};
	await loadPublicModels("console", "sk-k", fetcher);
	await loadPublicModels("console", "sk-k", fetcher);
	await loadPublicModels("console", "sk-k", fetcher);
	assert.equal(devFetches, 1);
});
