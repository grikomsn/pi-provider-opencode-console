import test from "node:test";
import assert from "node:assert/strict";
import {
	isTransientNetworkError,
	isTransientServerError,
	parseContextOverflow400,
	patchableOptionFrom400,
	retryDelayMs,
	statusFromErrorMessage,
} from "../src/retry.ts";

test("statusFromErrorMessage extracts statuses from pi-ai formatted errors", () => {
	assert.equal(statusFromErrorMessage("OpenAI (502): bad gateway"), 502);
	assert.equal(statusFromErrorMessage("403 status code (no body)"), 403);
	assert.equal(statusFromErrorMessage("OpenCode Console token exchange failed (429)"), 429);
	assert.equal(statusFromErrorMessage("connection refused"), undefined);
	// Only 4xx/5xx count as HTTP statuses.
	assert.equal(statusFromErrorMessage("(200)"), undefined);
	assert.equal(statusFromErrorMessage("(302)"), undefined);
});

test("isTransientServerError matches gateway errors and Router_Unavailable", () => {
	assert.equal(isTransientServerError(502, "bad gateway"), true);
	assert.equal(isTransientServerError(503, "unavailable"), true);
	assert.equal(isTransientServerError(504, "gateway timeout"), true);
	assert.equal(isTransientServerError(500, "Router_Unavailable: no upstream"), true);
	assert.equal(isTransientServerError(500, "Router.Unavailable"), true);
	assert.equal(isTransientServerError(500, "generic failure"), false);
	assert.equal(isTransientServerError(429, "rate limited"), false);
	assert.equal(isTransientServerError(404, "not found"), false);
});

test("isTransientNetworkError matches network faults but not aborts or API errors", () => {
	assert.equal(isTransientNetworkError(new Error("fetch failed")), true);
	assert.equal(
		isTransientNetworkError(new Error("request failed", { cause: new Error("socket hang up") })),
		true,
	);
	assert.equal(isTransientNetworkError(Object.assign(new Error("boom"), { name: "AbortError" })), false);
	assert.equal(isTransientNetworkError(new Error("HTTP 500: oops")), false);
	assert.equal(isTransientNetworkError("fetch failed"), false);
});

test("retryDelayMs doubles with a 2s cap", () => {
	assert.equal(retryDelayMs(0), 250);
	assert.equal(retryDelayMs(1), 500);
	assert.equal(retryDelayMs(2), 1000);
	assert.equal(retryDelayMs(3), 2000);
	assert.equal(retryDelayMs(10), 2000);
});

test("patchableOptionFrom400 maps rejected request fields to stream options", () => {
	assert.equal(patchableOptionFrom400("400: temperature is unsupported for this model"), "temperature");
	assert.equal(
		patchableOptionFrom400("extra inputs are not permitted, got input: 'reasoning_effort'"),
		"reasoning",
	);
	assert.equal(patchableOptionFrom400("thinking is unsupported for this model"), "reasoning");
	assert.equal(patchableOptionFrom400("budget_tokens invalid: must be positive"), "thinkingBudgets");
	assert.equal(patchableOptionFrom400("max_tokens is too large"), undefined);
	assert.equal(patchableOptionFrom400("invalid request: missing model"), undefined);
});
test("isTransientServerError matches the gateway's bare Internal server error", () => {
	assert.equal(isTransientServerError(500, "gateway (500): Internal server error."), true);
	assert.equal(isTransientServerError(500, ": Internal server error"), true);
	assert.equal(isTransientServerError(500, "some other 500 failure"), false);
});

test("parseContextOverflow400 computes a reduced completion budget (sibling formula)", () => {
	const message =
		"This model's maximum context length is 262,144 tokens, however you requested 300,000 tokens (168,928 in the messages, 131,072 in the completion). Please reduce the length of the messages or completion.";
	// requested - context = 37,856; reserve = max(256, ceil(262144 * 0.001)) = 263;
	// next = 131,072 - 37,856 - 263 = 92,953.
	assert.deepEqual(parseContextOverflow400(message), { nextMaxTokens: 92_953 });
	assert.equal(parseContextOverflow400("This model's maximum context length is 131072 tokens, however you requested 131200 tokens (131072 in the messages, 128 in the completion)."), undefined);
	assert.equal(parseContextOverflow400("maximum context length is 300000 tokens, however you requested 131200 tokens (131 in the messages, 64 in the completion)"), undefined);
	assert.equal(parseContextOverflow400("temperature is unsupported"), undefined);
});
