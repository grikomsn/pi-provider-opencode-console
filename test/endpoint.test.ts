import test from "node:test";
import assert from "node:assert/strict";
import { resolveRoute, routeFor, baseUrlFor } from "../src/endpoint.ts";

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
	assert.equal(resolveRoute("gemini-3-pro", "", "console"), "google-generative-ai");
	assert.equal(resolveRoute("gemini-3-pro", "", "go"), "openai-completions");
	// npm wins over id heuristics.
	assert.equal(resolveRoute("grok-3", "@ai-sdk/anthropic"), "anthropic-messages");
	// Explicit npm packages keep their mapping.
	assert.equal(resolveRoute("anything", "@ai-sdk/openai"), "openai-responses");
	// gpt-/claude- ids keep pre-existing routes.
	assert.equal(resolveRoute("gpt-6-luna", ""), "openai-responses");
	assert.equal(resolveRoute("claude-fable-5", ""), "anthropic-messages");
});

test("resolveRoute qwen3.8-max exact exception routes to completions on both gateways", () => {
	assert.equal(resolveRoute("qwen3.8-max", ""), "openai-completions");
	assert.equal(resolveRoute("qwen3.8-max", "", "go"), "openai-completions");
	assert.equal(resolveRoute("Qwen3.8-Max", ""), "openai-completions");
	// Other qwen tiers keep the messages family route.
	assert.equal(resolveRoute("qwen3.8-flash", ""), "anthropic-messages");
	assert.equal(resolveRoute("qwen3.8-max-free", ""), "anthropic-messages");
});
