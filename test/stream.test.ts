import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
	type Api,
	type AssistantMessage,
	type Context,
	type Model,
	type TextContent,
} from "@earendil-works/pi-ai/compat";
import { streamConsole } from "../src/stream.ts";

interface CapturedRequest {
	method?: string;
	url?: string;
	headers: Record<string, string>;
	body: string;
}

async function withFakeServer(
	handler: (req: CapturedRequest) => { status?: number; body: string; contentType?: string },
	fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
	const captured: CapturedRequest[] = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
		req.on("end", () => {
			const headers: Record<string, string> = {};
			for (const [k, v] of Object.entries(req.headers)) {
				if (typeof v === "string") headers[k.toLowerCase()] = v;
			}
			captured.push({ method: req.method, url: req.url, headers, body });
			const result = handler(captured[captured.length - 1]!);
			const status = result.status ?? 200;
			res.writeHead(status, {
				"content-type": result.contentType ?? "text/event-stream",
				"cache-control": "no-cache",
			});
			res.end(result.body);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	const baseUrl = `http://127.0.0.1:${port}`;
	try {
		await fn(baseUrl);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
}

function makeOpenAiCompletionsSSE(text: string): string {
	const completion = {
		id: "fake-1",
		object: "chat.completion.chunk",
		created: 1,
		model: "fake",
		choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }],
		usage: {
			prompt_tokens: 0,
			completion_tokens: text.length,
			total_tokens: text.length,
			cost: 0,
		},
	};
	return `data: ${JSON.stringify(completion)}\n\ndata: [DONE]\n\n`;
}

function makeModel(baseUrl: string, api: Api = "openai-completions", id = "fake-model"): Model<Api> {
	return {
		id,
		name: "Fake",
		api,
		provider: "opencode-console",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

function makeContext(prompt: string): Context {
	return {
		systemPrompt: "test",
		messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
	};
}

test("streamConsole injects bearer auth + x-opencode-org-id + x-opencode-client", async () => {
	const captured: CapturedRequest[] = [];
	await withFakeServer(
		(req) => {
			captured.push(req);
			return { body: makeOpenAiCompletionsSSE("hi") };
		},
		async (baseUrl) => {
			const model = makeModel(`${baseUrl}/v1`);
			const stream = streamConsole(model, makeContext("hello"), {
				accessToken: "the-token",
				orgId: "the-org",
			});
			let result: AssistantMessage | undefined;
			for await (const event of stream) {
				if (event.type === "done") {
					result = event.message;
					break;
				}
				if (event.type === "error") throw new Error("stream error: " + event.error.errorMessage);
			}
			assert.ok(result);
			assert.equal(result.stopReason, "stop");
			const text = result.content.find((c) => c.type === "text") as TextContent | undefined;
			assert.ok(text, "expected a text content part");
			assert.equal(text?.text, "hi");

			// Verify the upstream call carried our headers + the right path.
			assert.equal(captured.length, 1);
			const req = captured[0]!;
			assert.equal(req.headers["authorization"], "Bearer the-token");
			// The /inference/* surface requires x-opencode-org-id, NOT x-org-id.
			assert.equal(req.headers["x-opencode-org-id"], "the-org");
			assert.equal(req.headers["x-org-id"], undefined);
			assert.equal(req.headers["x-opencode-client"], "pi-provider-opencode-console");
			assert.equal(req.url, "/v1/chat/completions");
		},
	);
});

test("streamConsole strips /v1 from anthropic baseUrl before SDK", async () => {
	const captured: CapturedRequest[] = [];
	await withFakeServer(
		(req) => {
			captured.push(req);
			return {
				body: 'event: message_start\ndata: {"type":"message_start","message":{"id":"x","type":"message","role":"assistant","content":[],"model":"claude-x","stop_reason":null,"usage":{"input_tokens":0,"output_tokens":0}}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
			};
		},
		async (baseUrl) => {
			const model = makeModel(`${baseUrl}/v1`, "anthropic-messages", "claude-x");
			const stream = streamConsole(model, makeContext("hi"), { accessToken: "tok" });
			for await (const _event of stream) {
				/* drain */
			}
			// Anthropic SDK uses baseURL https://api.anthropic.com and appends /v1/messages.
			assert.equal(captured.length, 1);
			const req = captured[0]!;
			assert.equal(req.headers["x-api-key"], "tok");
			assert.equal(req.headers["anthropic-version"], "2023-06-01");
			assert.equal(req.url, "/v1/messages");
		},
	);
});

test("streamConsole emits an error event when the inner call fails", async () => {
	await withFakeServer(
		() => ({ status: 401, body: "unauthorized" }),
		async (baseUrl) => {
			const model = makeModel(`${baseUrl}/v1`);
			const stream = streamConsole(model, makeContext("hi"), { accessToken: "bad" });
			let sawError = false;
			let sawDone = false;
			for await (const event of stream) {
				if (event.type === "error") {
					sawError = true;
					assert.equal(event.error.stopReason, "error");
					assert.ok(event.error.errorMessage);
				}
				if (event.type === "done") sawDone = true;
			}
			assert.equal(sawError, true, "expected an error event");
			assert.equal(sawDone, false);
		},
	);
});

test("streamConsole routes google-generative-ai URLs correctly", async () => {
	const captured: CapturedRequest[] = [];
	await withFakeServer(
		(req) => {
			captured.push(req);
			return { status: 200, body: "data: {}\n\n" };
		},
		async (baseUrl) => {
			const model = makeModel(
				`${baseUrl}/v1beta`,
				"google-generative-ai",
				"gemini-test",
			);
			const stream = streamConsole(model, makeContext("hi"), { accessToken: "tok" });
			for await (const _event of stream) {
				/* drain */
			}
			assert.equal(captured.length, 1);
			// Google SDK adds /models/<id>:streamGenerateContent on top of baseUrl.
			assert.match(captured[0]!.url!, /\/v1beta\/models\/gemini-test:streamGenerateContent/);
			assert.equal(captured[0]!.headers["x-goog-api-key"], "tok");
		},
	);
});

test("streamConsole retries a transient 503 and succeeds", async () => {
	const captured: CapturedRequest[] = [];
	let calls = 0;
	await withFakeServer(
		(req) => {
			captured.push(req);
			calls++;
			if (calls === 1) return { status: 503, body: "upstream unavailable", contentType: "application/json" };
			return { body: makeOpenAiCompletionsSSE("recovered") };
		},
		async (baseUrl) => {
			const model = makeModel(`${baseUrl}/v1`);
			const stream = streamConsole(model, makeContext("hi"), { accessToken: "tok" });
			let done = false;
			for await (const event of stream) {
				if (event.type === "error") throw new Error("unexpected error: " + event.error.errorMessage);
				if (event.type === "done") done = true;
			}
			assert.equal(done, true);
			assert.equal(calls, 2, "expected one retry after the 503");
			assert.equal(captured.length, 2);
		},
	);
});

test("streamConsole force-refreshes once on 401 via refreshSession", async () => {
	const captured: CapturedRequest[] = [];
	let calls = 0;
	let refreshes = 0;
	await withFakeServer(
		(req) => {
			captured.push(req);
			calls++;
			if (calls === 1) return { status: 401, body: "unauthorized", contentType: "application/json" };
			return { body: makeOpenAiCompletionsSSE("fresh") };
		},
		async (baseUrl) => {
			const model = makeModel(`${baseUrl}/v1`);
			const stream = streamConsole(model, makeContext("hi"), {
				accessToken: "stale-token",
				orgId: "org-1",
				refreshSession: async () => {
					refreshes++;
					return { accessToken: "fresh-token", orgId: "org-1", requestId: "req-2" };
				},
			});
			let done = false;
			for await (const event of stream) {
				if (event.type === "error") throw new Error("unexpected error: " + event.error.errorMessage);
				if (event.type === "done") done = true;
			}
			assert.equal(done, true);
			assert.equal(refreshes, 1);
			assert.equal(calls, 2);
			assert.equal(captured[0]!.headers["authorization"], "Bearer stale-token");
			assert.equal(captured[1]!.headers["authorization"], "Bearer fresh-token");
		},
	);
});

test("streamConsole emits an error event when 401 persists after refresh", async () => {
	let calls = 0;
	let refreshes = 0;
	await withFakeServer(
		() => {
			calls++;
			return { status: 401, body: "unauthorized", contentType: "application/json" };
		},
		async (baseUrl) => {
			const model = makeModel(`${baseUrl}/v1`);
			const stream = streamConsole(model, makeContext("hi"), {
				accessToken: "stale",
				refreshSession: async () => {
					refreshes++;
					return { accessToken: "also-stale" };
				},
			});
			let sawError = false;
			for await (const event of stream) {
				if (event.type === "error") sawError = true;
			}
			assert.equal(sawError, true, "expected a terminal error event");
			assert.equal(refreshes, 1, "expected exactly one refresh attempt");
			assert.equal(calls, 2);
		},
	);
});

test("streamConsole drops a rejected temperature on 400 and retries", async () => {
	const captured: CapturedRequest[] = [];
	let calls = 0;
	await withFakeServer(
		(req) => {
			captured.push(req);
			calls++;
			if (calls === 1) {
				return {
					status: 400,
					body: JSON.stringify({ error: { message: "temperature is unsupported for this model" } }),
					contentType: "application/json",
				};
			}
			return { body: makeOpenAiCompletionsSSE("patched") };
		},
		async (baseUrl) => {
			const model = makeModel(`${baseUrl}/v1`);
			const stream = streamConsole(model, makeContext("hi"), { accessToken: "tok" }, { temperature: 0.7 });
			let done = false;
			for await (const event of stream) {
				if (event.type === "error") throw new Error("unexpected error: " + event.error.errorMessage);
				if (event.type === "done") done = true;
			}
			assert.equal(done, true);
			assert.equal(calls, 2);
			assert.deepEqual(JSON.parse(captured[0]!.body).temperature, 0.7);
			assert.equal(JSON.parse(captured[1]!.body).temperature, undefined);
		},
	);
});

test("streamConsole does not retry after content has been forwarded", async () => {
	let calls = 0;
	await withFakeServer(
		() => {
			calls++;
			// Truncated SSE: content arrives, then the connection body ends
			// without [DONE]; pi-ai treats that as an error stop reason.
			if (calls === 1) return { body: makeOpenAiCompletionsSSE("partial") };
			return { body: makeOpenAiCompletionsSSE("never") };
		},
		async (baseUrl) => {
			const model = makeModel(`${baseUrl}/v1`);
			const stream = streamConsole(model, makeContext("hi"), { accessToken: "tok" });
			for await (const _event of stream) {
				/* drain */
			}
			assert.equal(calls, 1, "must not re-issue a request after forwarding events");
		},
	);
});
