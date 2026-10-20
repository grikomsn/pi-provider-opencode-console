import test from "node:test";
import assert from "node:assert/strict";
import { apiBaseForMode, resolveRoute, routeFor, baseUrlFor } from "../src/endpoint.ts";

test("public catalogs use the canonical inference bases", () => {
	assert.equal(apiBaseForMode("console"), "https://opencode.ai/inference/v1");
	assert.equal(apiBaseForMode("go"), "https://opencode.ai/inference/go/v1");
});

test("resolveRoute by npm package", () => {
	assert.equal(resolveRoute("foo", "@ai-sdk/anthropic"), "anthropic-messages");
	assert.equal(resolveRoute("foo", "@ai-sdk/google"), "google-generative-ai");
	assert.equal(resolveRoute("foo", "@ai-sdk/openai"), "openai-responses");
	assert.equal(resolveRoute("foo", "@ai-sdk/openai-compatible"), "openai-completions");
});

test("resolveRoute by model id prefix when npm absent", () => {
	assert.equal(resolveRoute("gpt-5"), "openai-responses");
	assert.equal(resolveRoute("claude-sonnet-4-5"), "anthropic-messages");
});

test("resolveRoute defaults to openai-completions", () => {
	assert.equal(resolveRoute("llama-3"), "openai-completions");
	assert.equal(resolveRoute("llama-3", "@ai-sdk/anthropic"), "anthropic-messages");
});

test("routeFor emits correct auth headers", () => {
	const anthropic = routeFor("anthropic-messages");
	assert.deepEqual(anthropic.authHeader("t"), {
		"x-api-key": "t",
		"anthropic-version": "2023-06-01",
	});

	const openaiResp = routeFor("openai-responses");
	assert.equal(openaiResp.authHeader("t").Authorization, "Bearer t");

	const openaiChat = routeFor("openai-completions");
	assert.equal(openaiChat.authHeader("t").Authorization, "Bearer t");

	const google = routeFor("google-generative-ai");
	assert.equal(google.authHeader("t")["x-goog-api-key"], "t");
});

test("baseUrlFor strips /v1 for anthropic", () => {
	assert.equal(baseUrlFor("https://api.anthropic.com/v1", "anthropic-messages"), "https://api.anthropic.com");
	assert.equal(baseUrlFor("https://api.anthropic.com/v1/", "anthropic-messages"), "https://api.anthropic.com");
});

test("baseUrlFor keeps /v1 for openai-completions and openai-responses", () => {
	assert.equal(baseUrlFor("https://api.openai.com/v1", "openai-completions"), "https://api.openai.com/v1");
	assert.equal(baseUrlFor("https://api.openai.com/v1/", "openai-responses"), "https://api.openai.com/v1");
});

test("baseUrlFor keeps google-generative-ai base", () => {
	assert.equal(
		baseUrlFor("https://generativelanguage.googleapis.com/v1beta", "google-generative-ai"),
		"https://generativelanguage.googleapis.com/v1beta",
	);
	assert.equal(
		baseUrlFor("https://generativelanguage.googleapis.com/v1beta/", "google-generative-ai"),
		"https://generativelanguage.googleapis.com/v1beta",
	);
});

test("resolveRoute family heuristics (sibling parity)", () => {
	// Grok and Muse Spark families are Responses upstream even when models.dev omits npm.
	assert.equal(resolveRoute("grok-4.7", undefined), "openai-responses");
	assert.equal(resolveRoute("grok-build-0.1", ""), "openai-responses");
	assert.equal(resolveRoute("muse-spark-2", ""), "openai-responses");
	// Qwen tiers are Messages upstream on both gateways
	// (qwen3.8-max is the exact completion-mapped exception, tested below).
	// Mode-scoped families.
	assert.equal(resolveRoute("minimax-m3", "", "go"), "anthropic-messages");
	assert.equal(resolveRoute("minimax-m3", "", "console"), "openai-completions");
	assert.equal(resolveRoute("minimax-m3-free", "@ai-sdk/anthropic", "console"), "anthropic-messages");
	assert.equal(resolveRoute("gemini-3-pro", "", "console"), "google-generative-ai");
	assert.equal(resolveRoute("gemini-4-argon-contributor", "", "go"), "google-generative-ai");
	// npm wins over id heuristics.
	assert.equal(resolveRoute("grok-3", "@ai-sdk/anthropic"), "anthropic-messages");
	// Explicit npm packages keep their mapping.
	assert.equal(resolveRoute("anything", "@ai-sdk/openai"), "openai-responses");
	// gpt-/claude- ids keep pre-existing routes.
	assert.equal(resolveRoute("gpt-6-luna", ""), "openai-responses");
	assert.equal(resolveRoute("claude-fable-5", ""), "anthropic-messages");
});

test("resolveRoute qwen3.8-max uses the gateway-specific protocol", () => {
	assert.equal(resolveRoute("qwen3.8-max", ""), "openai-completions");
	assert.equal(resolveRoute("qwen3.8-max", "", "go"), "anthropic-messages");
	assert.equal(resolveRoute("qwen-3.8-max", "", "go"), "anthropic-messages");
	assert.equal(resolveRoute("qwen-3.8-max", ""), "openai-completions");
	assert.equal(resolveRoute("Qwen3.8-Max", ""), "openai-completions");
	// Other qwen tiers keep the messages family route.
	assert.equal(resolveRoute("qwen3.8-flash", ""), "anthropic-messages");
	assert.equal(resolveRoute("qwen3.8-max-free", ""), "anthropic-messages");
});

test("resolveRoute honours an OpenAI-kind catalog base before the MiniMax fallback", () => {
	// The Go catalog base for MiniMax is OpenAI-style: `/openai/v1` serves
	// Chat Completions, while Anthropic Messages would 404 on `/openai/v1/messages`.
	assert.equal(
		resolveRoute("minimax-m3.1-flash-free", undefined, "go", "https://opencode.ai/inference/go/openai/v1"),
		"openai-completions",
	);
	// Trailing slashes are ignored.
	assert.equal(
		resolveRoute("minimax-m3.1-flash-free", undefined, "go", "https://opencode.ai/inference/go/openai/v1/"),
		"openai-completions",
	);
	// Without a base URL the Go MiniMax fallback still uses Messages.
	assert.equal(resolveRoute("minimax-m3.1-flash-free", undefined, "go"), "anthropic-messages");
	// An explicit anthropic npm still wins over an OpenAI-style base.
	assert.equal(
		resolveRoute("minimax-m3.1-flash-free", "@ai-sdk/anthropic", "go", "https://opencode.ai/inference/go/openai/v1"),
		"anthropic-messages",
	);
	// ... and so does the explicit openai npm (Responses).
	assert.equal(
		resolveRoute("minimax-m3.1-flash-free", "@ai-sdk/openai", "go", "https://opencode.ai/inference/go/openai/v1"),
		"openai-responses",
	);
});

test("resolveRoute keeps the gpt family on Responses even with an OpenAI-kind base", () => {
	// The OpenAI-kind base override applies to the Go MiniMax fallback only;
	// a GPT row must not be switched to Chat Completions by its base URL.
	assert.equal(
		resolveRoute("gpt-6-luna", undefined, "go", "https://opencode.ai/inference/go/openai/v1"),
		"openai-responses",
	);
});

test("resolveRoute keeps Console MiniMax on Chat Completions", () => {
	// Console behaviour is unchanged: MiniMax on Console uses Chat Completions.
	assert.equal(
		resolveRoute("minimax-m3.1-flash-free", undefined, "console", "https://opencode.ai/inference/openai/v1"),
		"openai-completions",
	);
});

test("baseUrlFor resolves generic OpenCode gateways before SDK path composition", () => {
	for (const scope of ["", "/go"]) {
		for (const prefix of ["zen", "inference"]) {
			const base = `https://opencode.ai/${prefix}${scope}/v1/`;
			assert.equal(baseUrlFor(base, "openai-completions"), `https://opencode.ai/inference${scope}/openai/v1`);
			assert.equal(baseUrlFor(base, "openai-responses"), `https://opencode.ai/inference${scope}/openai/v1`);
			assert.equal(baseUrlFor(base, "anthropic-messages"), `https://opencode.ai/inference${scope}/anthropic`);
			assert.equal(baseUrlFor(base, "google-generative-ai"), `https://opencode.ai/inference${scope}/google/v1beta`);
		}
	}
	assert.equal(baseUrlFor("https://opencode.ai/inference/go/google/v1beta/", "google-generative-ai"), "https://opencode.ai/inference/go/google/v1beta");
	assert.equal(baseUrlFor("https://custom.test/zen/go/v1", "google-generative-ai"), "https://custom.test/zen/go/v1");
	assert.equal(baseUrlFor("https://opencode.ai.example.test/inference/v1", "google-generative-ai"), "https://opencode.ai.example.test/inference/v1");
});
