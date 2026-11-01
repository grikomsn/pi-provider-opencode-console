import { appendFileSync } from "node:fs";

/**
 * Loaded only by the packed-extension smoke test (`test/installed.test.ts`)
 * as an extra pi extension inside an isolated agent directory. It replaces
 * `fetch` so no request can leave the machine: the one expected OpenCode Go
 * inference call is answered with a canned OpenAI-compatible stream, and
 * every other request is logged as unexpected and rejected.
 */
const EXPECTED_URL = "https://opencode.ai/inference/go/openai/v1/chat/completions";

function record(line: string): void {
	appendFileSync(process.env.OPENCODE_TEST_FETCH_LOG!, `${line}\n`);
}

function headerValue(init: RequestInit | undefined, name: string): string | undefined {
	return new Headers(init?.headers).get(name) ?? undefined;
}

export default function installTestFetch(): void {
	globalThis.fetch = async (input, init) => {
		const url = input instanceof Request ? input.url : String(input);
		if (url !== EXPECTED_URL) {
			record(`unexpected ${url}`);
			throw new TypeError(`fetch blocked by smoke-test fixture: ${url}`);
		}
		const payload = JSON.parse(String(init?.body)) as { model?: unknown };
		const checks = [
			`model=${String(payload.model)}`,
			`auth=${headerValue(init, "authorization") === "Bearer smoke-access-token"}`,
			`org=${headerValue(init, "x-opencode-org-id") ?? ""}`,
			`session=${Boolean(headerValue(init, "x-opencode-session"))}`,
		];
		record(`inference ${checks.join(" ")}`);
		const chunk = {
			id: "opencode-smoke",
			object: "chat.completion.chunk",
			created: 1,
			model: payload.model,
			choices: [{ index: 0, delta: { role: "assistant", content: "PACKED_OPENCODE_OK" }, finish_reason: null }],
		};
		const end = {
			...chunk,
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
		};
		return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`, {
			headers: { "content-type": "text/event-stream" },
		});
	};
}
