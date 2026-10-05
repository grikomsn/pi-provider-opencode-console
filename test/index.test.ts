import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import providerFactory from "../src/index.ts";

// Capture the registered providers + commands.
interface CapturedProvider {
	name: string;
	config: Record<string, unknown>;
}

function makeFakePi() {
	const providers: CapturedProvider[] = [];
	const commands: { name: string; handler: (args: string, ctx: unknown) => Promise<void> }[] = [];
	return {
		providers,
		commands,
		registerProvider(name: string, config: Record<string, unknown>) {
			providers.push({ name, config });
		},
		registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			commands.push({ name, handler: options.handler });
		},
	};
}

const cast = (x: unknown) => x as never;

/**
 * Build a temporary auth.json so the extension thinks a user is signed in.
 */
async function withAuthFile(
	content: object,
	fn: () => Promise<void>,
): Promise<void> {
	const dir = join(tmpdir(), `pi-provider-opencode-console-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await mkdir(dir, { recursive: true });
	const fakeHome = join(dir, "home");
	await mkdir(fakeHome, { recursive: true });
	const fakeAuthDir = join(fakeHome, ".pi", "agent");
	await mkdir(fakeAuthDir, { recursive: true });
	await writeFile(join(fakeAuthDir, "auth.json"), JSON.stringify(content), { mode: 0o600 });
	// Capture and restore HOME around the callback: a leaked HOME pointed at
	// a removed temp dir would let later tests in this file (e.g. the
	// oauth.login flow, which persists via saveSession) recreate and write to
	// a bogus location — or, when no redirect ever ran (isolated test runs),
	// clobber the REAL ~/.pi/agent/auth.json.
	const prevHome = process.env.HOME;
	process.env.HOME = fakeHome;
	try {
		await fn();
	} finally {
		await rm(dir, { recursive: true, force: true });
		if (prevHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = prevHome;
		}
	}
}

interface CapturedConfig {
	name?: string;
	api?: string;
	models?: unknown[];
	apiKey?: string;
	baseUrl?: string;
	oauth?: { name?: string; isSubscription?: boolean; login?: unknown; refreshToken?: unknown; getApiKey?: unknown };
	refreshModels?: unknown;
	streamSimple?: unknown;
}

test("extension registers the console and go providers", async () => {
	const pi = makeFakePi();
	providerFactory(cast(pi));
	assert.equal(pi.providers.length, 2);
	assert.equal(pi.providers[0]!.name, "opencode-console");
	assert.equal(pi.providers[1]!.name, "opencode-go-console");

	for (const [idx, oauthName] of [[0, "OpenCode Console (device sign-in)"], [1, "OpenCode Go (device sign-in)"]] as const) {
		const cfg = pi.providers[idx]!.config as CapturedConfig;
		assert.equal(cfg.name, idx === 0 ? "OpenCode Console" : "OpenCode Go");
		assert.deepEqual(cfg.models, []);
		// API-key auth registered so pi's standard api_key entries resolve.
		assert.equal(cfg.apiKey, "$OPENCODE_API_KEY");
		assert.ok(cfg.oauth);
		assert.equal(cfg.oauth!.name, oauthName);
		assert.equal(cfg.oauth!.isSubscription, true);
		assert.equal(typeof cfg.oauth!.login, "function");
		assert.equal(typeof cfg.oauth!.refreshToken, "function");
		assert.equal(typeof cfg.oauth!.getApiKey, "function");
		assert.equal(typeof cfg.refreshModels, "function");
		assert.equal(typeof cfg.streamSimple, "function");
	}
});

test("extension registers /opencode-console and /opencode-go-console commands", async () => {
	const pi = makeFakePi();
	providerFactory(cast(pi));
	assert.equal(pi.commands.length, 2);
	assert.equal(pi.commands[0]!.name, "opencode-console");
	assert.equal(pi.commands[1]!.name, "opencode-go-console");
});

test("refreshModels returns [] when no orgId in auth.json", async () => {
	const pi = makeFakePi();
	providerFactory(cast(pi));
	const provider = pi.providers[0]!;
	const refreshModels = provider.config.refreshModels as (ctx: unknown) => Promise<unknown[]>;
	await withAuthFile(
		{
			"opencode-console": {
				type: "oauth",
				refresh: "rt",
				access: "at",
				expires: Date.now() + 60 * 60_000,
				env: {
					OPENCODE_CONSOLE_SERVER: "https://console.example.test",
					OPENCODE_CONSOLE_ACCOUNT_ID: "acct",
					OPENCODE_CONSOLE_EMAIL: "u@example.test",
				},
			},
		},
		async () => {
			const result = await refreshModels({});
			assert.deepEqual(result, []);
		},
	);
});

test("refreshModels calls /api/config when org is present", async () => {
	const pi = makeFakePi();
	providerFactory(cast(pi));
	const provider = pi.providers[0]!;
	const refreshModels = provider.config.refreshModels as (
		ctx: { signal?: AbortSignal; publish?: (p: { persist: unknown }) => Promise<boolean> },
	) => Promise<Array<{ id: string }>>;
	let captured: Record<string, string> | undefined;
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
		req.on("end", () => {
			captured = Object.fromEntries(
				Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : (v ?? "")]),
			) as Record<string, string>;
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					config: {
						provider: {
							opencode: {
								api: "https://api.example.test/v1",
								models: {
									"claude-x": {
										name: "Claude X",
										reasoning: false,
										limit: { context: 200_000, output: 8_192 },
									},
								},
							},
						},
					},
				}),
			);
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const port = (server.address() as AddressInfo).port;
	const serverUrl = `http://127.0.0.1:${port}`;
	try {
		await withAuthFile(
			{
				"opencode-console": {
					type: "oauth",
					refresh: "rt",
					access: "at",
					expires: Date.now() + 60 * 60_000,
					env: {
						OPENCODE_CONSOLE_SERVER: serverUrl,
						OPENCODE_CONSOLE_ACCOUNT_ID: "acct",
						OPENCODE_CONSOLE_EMAIL: "u@example.test",
						OPENCODE_CONSOLE_ORG_ID: "org-1",
						OPENCODE_CONSOLE_ORG_NAME: "Org One",
					},
				},
			},
			async () => {
				let published: { persist: unknown } | undefined;
				const models = await refreshModels({
					publish: (p: { persist: unknown }) => {
						published = p;
						return Promise.resolve(true);
					},
				});
				assert.equal(models.length, 1);
				assert.equal(models[0]!.id, "claude-x");
				assert.ok(published, "expected publish() to be called");
				assert.ok(captured);
				assert.equal(captured!["x-org-id"], "org-1");
				assert.equal(captured!["authorization"], "Bearer at");
			},
		);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((r) => server.close(() => r()));
	}
});

test("refreshModels returns [] when /api/config fails", async () => {
	const pi = makeFakePi();
	providerFactory(cast(pi));
	const provider = pi.providers[0]!;
	const refreshModels = provider.config.refreshModels as (
		ctx: { signal?: AbortSignal; publish?: (p: { persist: unknown }) => Promise<boolean> },
	) => Promise<unknown[]>;
	const server = createServer((req, res) => {
		req.on("data", () => {});
		req.on("end", () => {
			res.writeHead(500);
			res.end("server error");
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const port = (server.address() as AddressInfo).port;
	const serverUrl = `http://127.0.0.1:${port}`;
	try {
		await withAuthFile(
			{
				"opencode-console": {
					type: "oauth",
					refresh: "rt",
					access: "at",
					expires: Date.now() + 60 * 60_000,
					env: {
						OPENCODE_CONSOLE_SERVER: serverUrl,
						OPENCODE_CONSOLE_ACCOUNT_ID: "acct",
						OPENCODE_CONSOLE_EMAIL: "u@example.test",
						OPENCODE_CONSOLE_ORG_ID: "org-1",
					},
				},
			},
			async () => {
				const models = await refreshModels({});
				assert.deepEqual(models, []);
			},
		);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((r) => server.close(() => r()));
	}
});

test("refreshModels serves the stored catalog for the cache-only pass", async () => {
	const pi = makeFakePi();
	providerFactory(cast(pi));
	const provider = pi.providers[0]!;
	const refreshModels = provider.config.refreshModels as (ctx: {
		allowNetwork?: boolean;
		stored?: { models: Array<{ id: string; name: string }> };
	}) => Promise<Array<{ id: string; name: string }>>;
	// pi calls refreshModels with allowNetwork === false during startup and in
	// `-p` mode; the composer treats the return value as the authoritative
	// catalog, so it must be the persisted list rather than [].
	const stored = {
		models: [
			{ id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
			{ id: "glm-5.3", name: "GLM 5.3" },
		],
	};
	const models = await refreshModels({ allowNetwork: false, stored });
	assert.deepEqual(models, stored.models);
});

test("refreshModels keeps the stored catalog when the network refresh fails", async () => {
	const pi = makeFakePi();
	providerFactory(cast(pi));
	const provider = pi.providers[0]!;
	const refreshModels = provider.config.refreshModels as (ctx: {
		signal?: AbortSignal;
		stored?: { models: Array<{ id: string; name: string }> };
	}) => Promise<Array<{ id: string; name: string }>>;
	const server = createServer((req, res) => {
		req.on("data", () => {});
		req.on("end", () => {
			res.writeHead(500);
			res.end("server error");
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const port = (server.address() as AddressInfo).port;
	const serverUrl = `http://127.0.0.1:${port}`;
	try {
		await withAuthFile(
			{
				"opencode-console": {
					type: "oauth",
					refresh: "rt",
					access: "at",
					expires: Date.now() + 60 * 60_000,
					env: {
						OPENCODE_CONSOLE_SERVER: serverUrl,
						OPENCODE_CONSOLE_ACCOUNT_ID: "acct",
						OPENCODE_CONSOLE_EMAIL: "u@example.test",
						OPENCODE_CONSOLE_ORG_ID: "org-1",
					},
				},
			},
			async () => {
				const stored = { models: [{ id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" }] };
				const models = await refreshModels({ stored });
				assert.deepEqual(models, stored.models);
			},
		);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((r) => server.close(() => r()));
	}
});

test("getApiKey returns the access token", async () => {
	const pi = makeFakePi();
	providerFactory(cast(pi));
	const provider = pi.providers[0]!;
	const oauth = provider.config.oauth as { getApiKey: (c: { access: string }) => string };
	assert.equal(oauth.getApiKey({ access: "abc" }), "abc");
});

test("command warns when not signed in", async () => {
	// Hermetic: redirect HOME so this does not depend on the real auth.json.
	await withAuthFile({}, async () => {
	const pi = makeFakePi();
	providerFactory(cast(pi));
	const handler = pi.commands[0]!.handler;
	const notifications: { message: string; type?: string }[] = [];
	const fakeCtx = {
		ui: {
			notify: (message: string, type?: string) => notifications.push({ message, type }),
			select: async () => undefined,
			confirm: async () => false,
			input: async () => undefined,
		},
	};
		await handler("", fakeCtx);
	assert.equal(notifications.length, 1);
	assert.match(notifications[0]!.message, /Not signed in/);
	});
});

test("oauth.login returns credentials with env block", async () => {
	// Drive the OAuth login flow end-to-end against a fake console + fake
	// pi callbacks. The returned OAuthCredentials must include the env block
	// (server, orgId, accountId, email) so pi persists it to auth.json.
	const fakeConsole = createServer((req, res) => {
		const url = String(req.url);
		let body = "";
		req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
		req.on("end", () => {
			if (url.endsWith("/auth/device/code")) {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						device_code: "dev-1",
						user_code: "ABCD-1234",
						verification_uri_complete: "https://console.example.test/activate",
						expires_in: 600,
						interval: 1,
					}),
				);
				return;
			}
			if (url.endsWith("/auth/device/token")) {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						access_token: "at-login",
						refresh_token: "rt-login",
						expires_in: 3600,
					}),
				);
				return;
			}
			if (url.endsWith("/api/user")) {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ id: "acct-1", email: "u@example.test" }));
				return;
			}
			if (url.endsWith("/api/orgs")) {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify([{ id: "org-7", name: "Org Seven" }]));
				return;
			}
			res.writeHead(404);
			res.end();
		});
	});
	await new Promise<void>((r) => fakeConsole.listen(0, "127.0.0.1", r));
	const port = (fakeConsole.address() as AddressInfo).port;
	const serverUrl = `http://127.0.0.1:${port}`;
	process.env.OPENCODE_CONSOLE_SERVER = serverUrl;

	// Redirect HOME for the login flow: its saveSession writes to
	// ~/.pi/agent/auth.json, which must never be the developer's real file.
	await withAuthFile({}, async () => {
	const pi = makeFakePi();
	providerFactory(cast(pi));
	const provider = pi.providers[0]!;
	const oauth = provider.config.oauth as {
		login: (callbacks: unknown) => Promise<{ refresh: string; access: string; expires: number; env?: Record<string, string> }>;
	};
	const callbacks = {
		onDeviceCode: () => {},
		onAuth: () => {},
		onPrompt: async () => "",
		onProgress: () => {},
		onSelect: async () => undefined,
		signal: new AbortController().signal,
	};
	const credentials = await oauth.login(callbacks);
	try {
		assert.equal(credentials.refresh, "rt-login");
		assert.equal(credentials.access, "at-login");
		assert.ok(credentials.env, "login must return an env block");
		assert.equal(credentials.env!.OPENCODE_CONSOLE_SERVER, serverUrl);
		assert.equal(credentials.env!.OPENCODE_CONSOLE_ACCOUNT_ID, "acct-1");
		assert.equal(credentials.env!.OPENCODE_CONSOLE_EMAIL, "u@example.test");
		assert.equal(credentials.env!.OPENCODE_CONSOLE_ORG_ID, "org-7");
		assert.equal(credentials.env!.OPENCODE_CONSOLE_ORG_NAME, "Org Seven");
	} finally {
		fakeConsole.closeAllConnections();
		await new Promise<void>((r) => fakeConsole.close(() => r()));
		delete process.env.OPENCODE_CONSOLE_SERVER;
	}
	});
});

test("oauth.refreshToken returns refreshed credentials with env block", async () => {
	// Seed auth.json with an expiring session and a fake console that
	// answers refresh-token POSTs. The refresh must return env so pi does
	// not drop the orgId/server on the next refresh.
	const fakeConsole = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
		req.on("end", () => {
			if (String(req.url).endsWith("/auth/device/token")) {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						access_token: "at-refreshed",
						refresh_token: "rt-refreshed",
						expires_in: 7200,
					}),
				);
				return;
			}
			res.writeHead(404);
			res.end();
		});
	});
	await new Promise<void>((r) => fakeConsole.listen(0, "127.0.0.1", r));
	const port = (fakeConsole.address() as AddressInfo).port;
	const serverUrl = `http://127.0.0.1:${port}`;
	try {
		await withAuthFile(
			{
				"opencode-console": {
					type: "oauth",
					refresh: "rt-old",
					access: "at-old",
					expires: Date.now() - 1_000, // already expired
					env: {
						OPENCODE_CONSOLE_SERVER: serverUrl,
						OPENCODE_CONSOLE_ACCOUNT_ID: "acct-1",
						OPENCODE_CONSOLE_EMAIL: "u@example.test",
						OPENCODE_CONSOLE_ORG_ID: "org-7",
						OPENCODE_CONSOLE_ORG_NAME: "Org Seven",
					},
				},
			},
			async () => {
				const pi = makeFakePi();
				providerFactory(cast(pi));
				const provider = pi.providers[0]!;
				const oauth = provider.config.oauth as {
					refreshToken: (
						c: unknown,
						signal: AbortSignal,
					) => Promise<{ refresh: string; access: string; expires: number; env?: Record<string, string> }>;
				};
				const out = await oauth.refreshToken(
					{ refresh: "rt-old", access: "at-old", expires: 0 },
					new AbortController().signal,
				);
				assert.equal(out.access, "at-refreshed");
				assert.equal(out.refresh, "rt-refreshed");
				assert.ok(out.env, "refreshToken must return an env block");
				assert.equal(out.env!.OPENCODE_CONSOLE_SERVER, serverUrl);
				assert.equal(out.env!.OPENCODE_CONSOLE_ORG_ID, "org-7");
				assert.equal(out.env!.OPENCODE_CONSOLE_ORG_NAME, "Org Seven");
			},
		);
	} finally {
		fakeConsole.closeAllConnections();
		await new Promise<void>((r) => fakeConsole.close(() => r()));
	}
});

// --- service-key support ---

test("registration exposes API-key auth so service keys resolve", async () => {
	const pi = makeFakePi();
	providerFactory(cast(pi));
	const cfg = pi.providers[0]!.config as { apiKey?: string };
	assert.equal(cfg.apiKey, "$OPENCODE_API_KEY");
});

test("refreshModels loads the public /models catalog for an api_key credential", async () => {
	const pi = makeFakePi();
	providerFactory(cast(pi));
	const provider = pi.providers[0]!;
	const refreshModels = provider.config.refreshModels as (
		ctx: {
			signal?: AbortSignal;
			credential?: unknown;
			publish?: (p: { persist: unknown }) => Promise<boolean>;
		},
	) => Promise<Array<{ id: string }>>;

	const calls: string[] = [];
	const bearer: string[] = [];
	const prevFetch = globalThis.fetch;
	globalThis.fetch = (async (input, init) => {
		const url = String(input);
		calls.push(url);
		if (url.includes("models.dev")) return new Response("{}", { status: 200 });
		bearer.push(new Headers(init?.headers).get("authorization") ?? "");
		return new Response(
			JSON.stringify({
				data: [{ id: "public-model", name: "Public", limit: { context: 128_000, output: 8_192 } }],
			}),
			{ status: 200 },
		);
	}) as typeof fetch;
	try {
		let published: { persist: unknown } | undefined;
		const models = await refreshModels({
			credential: { type: "api_key", key: "sk-index-key" },
			publish: (p) => {
				published = p;
				return Promise.resolve(true);
			},
		});
		assert.equal(models.length, 1);
		assert.equal(models[0]!.id, "public-model");
		assert.ok(calls[0]!.endsWith("/zen/v1/models"), calls[0]);
		assert.equal(bearer[0], "Bearer sk-index-key");
		assert.ok(published);
	} finally {
		globalThis.fetch = prevFetch;
	}
});

test("streamSimple uses a stored service key without org identity", async () => {
	const pi = makeFakePi();
	providerFactory(cast(pi));
	const provider = pi.providers[0]!;
	const streamSimple = provider.config.streamSimple as (
		model: object,
		context: object,
		options?: object,
	) => AsyncIterable<{ type: string; error?: { errorMessage: string } }>;

	const requests: { url: string; headers: Record<string, string> }[] = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk.toString("utf8")));
		req.on("end", () => {
			requests.push({
				url: req.url ?? "",
				headers: Object.fromEntries(
					Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : (v ?? "")]),
				),
			});
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end('data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"fake","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0,"cost":0}}\n\ndata: [DONE]\n\n');
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const port = (server.address() as AddressInfo).port;
	const prevFetch = globalThis.fetch;
	// Guard against accidental refresh traffic; pass localhost through so the
	// fake streaming server still receives requests.
	globalThis.fetch = (async (input, init) => {
		const url = String(input);
		if (!url.includes("127.0.0.1")) {
			throw new Error("service keys must not refresh sessions");
		}
		return prevFetch(input as never, init as never);
	}) as typeof fetch;
	try {
		await withAuthFile(
			{ "opencode-console": { type: "api_key", key: "sk-stream-key-1234567890" } },
			async () => {
				const model = {
					id: "m",
					name: "M",
					api: "openai-completions",
					provider: "opencode-console",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					baseUrl: `http://127.0.0.1:${port}/v1`,
				};
				for await (const event of streamSimple(model, { systemPrompt: "x", messages: [] })) {
					assert.ok(event.type !== "error");
				}
			},
		);
	} finally {
		globalThis.fetch = prevFetch;
		server.closeAllConnections();
		await new Promise<void>((r) => server.close(() => r()));
	}
	assert.equal(requests.length, 1);
	assert.equal(requests[0]!.headers["authorization"], "Bearer sk-stream-key-1234567890");
	assert.equal(requests[0]!.headers["x-opencode-org-id"], undefined);
});

// --- Go provider (opencode-go-console) ---

test("go oauth.login saves the shared console device session under the go id", async () => {
	// Same fake-console dance as the console login test; the persisted entry
	// must land under opencode-go-console.
	const fakeConsole = createServer((req, res) => {
		const url = String(req.url);
		let body = "";
		req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
		req.on("end", () => {
			if (url.endsWith("/auth/device/code")) {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({
						device_code: "go-dev-1",
						user_code: "GO-1234",
						verification_uri_complete: "https://console.example.test/activate",
						expires_in: 600,
						interval: 1,
					}),
				);
				return;
			}
			if (url.endsWith("/auth/device/token")) {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(
					JSON.stringify({ access_token: "at-go", refresh_token: "rt-go", expires_in: 3600 }),
				);
				return;
			}
			if (url.endsWith("/api/user")) {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ id: "acct-1", email: "u@example.test" }));
				return;
			}
			if (url.endsWith("/api/orgs")) {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify([{ id: "org-7", name: "Org Seven" }]));
				return;
			}
			res.writeHead(404);
			res.end();
		});
	});
	await new Promise<void>((r) => fakeConsole.listen(0, "127.0.0.1", r));
	const serverUrl = `http://127.0.0.1:${(fakeConsole.address() as AddressInfo).port}`;
	process.env.OPENCODE_CONSOLE_SERVER = serverUrl;
	try {
		await withAuthFile({}, async () => {
			const pi = makeFakePi();
			providerFactory(cast(pi));
			const goProvider = pi.providers[1]!;
			const oauth = goProvider.config.oauth as {
				login: (cb: unknown) => Promise<{ refresh: string; access: string; expires: number; env?: Record<string, string> }>;
			};
			const out = await oauth.login({
				onDeviceCode: () => {},
				onAuth: () => {},
				onPrompt: async () => "",
				onProgress: () => {},
				onSelect: async () => undefined,
				signal: new AbortController().signal,
			});
			assert.equal(out.access, "at-go");
			assert.equal(out.refresh, "rt-go");
			assert.equal(out.env!.OPENCODE_CONSOLE_ORG_ID, "org-7");
			// The login persisted the session under the go provider id.
			const persisted = JSON.parse(
				await readFile(join(process.env.HOME!, ".pi", "agent", "auth.json"), "utf8"),
			) as Record<string, { type: string }>;
			assert.equal(persisted["opencode-go-console"]!.type, "oauth");
			assert.equal(persisted["opencode-console"], undefined, "go login must not clobber a console entry");
		});
	} finally {
		fakeConsole.closeAllConnections();
		await new Promise<void>((r) => fakeConsole.close(() => r()));
		delete process.env.OPENCODE_CONSOLE_SERVER;
	}
});

test("go refreshModels always loads the public Go /models catalog", async () => {
	const pi = makeFakePi();
	providerFactory(cast(pi));
	const goProvider = pi.providers[1]!;
	const refreshModels = goProvider.config.refreshModels as (
		ctx: {
			signal?: AbortSignal;
			allowNetwork?: boolean;
			credential?: unknown;
			publish?: (p: { persist: unknown }) => Promise<boolean>;
		},
	) => Promise<Array<{ id: string }>>;

	const urls: string[] = [];
	const auths: string[] = [];
	const prevFetch = globalThis.fetch;
	globalThis.fetch = (async (input, init) => {
		const url = String(input);
		if (url.includes("models.dev")) return new Response("{}", { status: 200 });
		// Only the gateway /models fetch contributes to urls/auths (each
		// refresh makes one /models request plus one models.dev request).
		urls.push(url);
		auths.push(new Headers(init?.headers).get("authorization") ?? "");
		return new Response(
			JSON.stringify({ data: [{ id: "go-model", name: "GoModel" }] }),
			{ status: 200 },
		);
	}) as typeof fetch;
	try {
		// api_key credential: Bearer service key.
		const models = await refreshModels({
			credential: { type: "api_key", key: "sk-go-key" },
			publish: () => Promise.resolve(true),
		});
		assert.equal(models.length, 1);
		assert.equal(models[0]!.id, "go-model");
		assert.ok(urls[0]!.endsWith("/zen/go/v1/models"), urls[0]);
		assert.equal(auths[0], "Bearer sk-go-key");

		// oauth credential: Bearer console access token.
		const out2 = await refreshModels({
			credential: { type: "oauth", access: "at-x", refresh: "rt-x", expires: 9e15 },
			publish: () => Promise.resolve(true),
		});
		assert.equal(out2.length, 1);
		assert.ok(urls[1]!.endsWith("/zen/go/v1/models"), urls[1]);
		assert.equal(auths[1], "Bearer at-x");

		// No credential: anonymous catalog still resolves (auth-ignored).
		const out3 = await refreshModels({
			publish: () => Promise.resolve(true),
		});
		assert.equal(out3.length, 1);
		assert.equal(auths[2], "");

		// Offline phase: no network, no models.
		urls.length = 0;
		const offline = await refreshModels({ allowNetwork: false, publish: () => Promise.resolve(true) });
		assert.deepEqual(offline, []);
		assert.equal(urls.length, 0);
	} finally {
		globalThis.fetch = prevFetch;
	}
});

test("go streamSimple sends the session access token with x-org-id alias", async () => {
	const pi = makeFakePi();
	providerFactory(cast(pi));
	const goProvider = pi.providers[1]!;
	const streamSimple = goProvider.config.streamSimple as (
		model: object,
		context: object,
		options?: object,
	) => AsyncIterable<{ type: string; error?: { errorMessage: string } }>;

	const requests: { headers: Record<string, string>; body: string }[] = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk.toString("utf8")));
		req.on("end", () => {
			requests.push({
				headers: Object.fromEntries(
					Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : (v ?? "")]),
				),
				body,
			});
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end('data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"fake","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0,"cost":0}}\n\ndata: [DONE]\n\n');
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	try {
		await withAuthFile(
			{
				"opencode-go-console": {
					type: "oauth",
					refresh: "rt",
					access: "at-go-session",
					expires: Date.now() + 60 * 60_000,
					env: {
						OPENCODE_CONSOLE_SERVER: "https://console.example.test",
						OPENCODE_CONSOLE_ACCOUNT_ID: "acct",
						OPENCODE_CONSOLE_EMAIL: "u@example.test",
						OPENCODE_CONSOLE_ORG_ID: "org-go",
						OPENCODE_CONSOLE_ORG_NAME: "Org Go",
					},
				},
			},
			async () => {
				const model = {
					id: "gm",
					name: "GM",
					api: "openai-completions",
					provider: "opencode-go-console",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
				};
				for await (const event of streamSimple(model, { systemPrompt: "x", messages: [] })) {
					assert.ok(event.type !== "error", JSON.stringify(event));
				}
			},
		);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((r) => server.close(() => r()));
	}
	assert.equal(requests.length, 1);
	assert.equal(requests[0]!.headers["authorization"], "Bearer at-go-session");
	// Go session requests carry the org id on both header spellings.
	assert.equal(requests[0]!.headers["x-opencode-org-id"], "org-go");
	assert.equal(requests[0]!.headers["x-org-id"], "org-go");
});

test("go streamSimple falls back to the console service key when no go entry exists", async () => {
	const pi = makeFakePi();
	providerFactory(cast(pi));
	const goProvider = pi.providers[1]!;
	const streamSimple = goProvider.config.streamSimple as (
		model: object,
		context: object,
		options?: object,
	) => AsyncIterable<{ type: string }>;

	const requests: { headers: Record<string, string> }[] = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk.toString("utf8")));
		req.on("end", () => {
			requests.push({
				headers: Object.fromEntries(
					Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : (v ?? "")]),
				),
			});
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end('data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"fake","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0,"cost":0}}\n\ndata: [DONE]\n\n');
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	try {
		await withAuthFile(
			{ "opencode-console": { type: "api_key", key: "sk-shared-key-1234567890" } },
			async () => {
				const model = {
					id: "gm",
					name: "GM",
					api: "openai-completions",
					provider: "opencode-go-console",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
				};
				for await (const event of streamSimple(model, { systemPrompt: "x", messages: [] })) {
					assert.ok(event.type !== "error");
				}
			},
		);
	} finally {
		server.closeAllConnections();
		await new Promise<void>((r) => server.close(() => r()));
	}
	assert.equal(requests.length, 1);
	assert.equal(requests[0]!.headers["authorization"], "Bearer sk-shared-key-1234567890");
	assert.equal(requests[0]!.headers["x-opencode-org-id"], undefined);
});

test("device-session streamSimple recovers from a mid-stream 401 (initial load keeps refreshSession)", async () => {
	const pi = makeFakePi();
	providerFactory(cast(pi));
	const provider = pi.providers[0]!;
	const streamSimple = provider.config.streamSimple as (
		model: object,
		context: object,
		options?: object,
	) => AsyncIterable<{ type: string }>;

	const requests: { headers: Record<string, string> }[] = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => (body += chunk.toString("utf8")));
		req.on("end", () => {
			requests.push({
				headers: Object.fromEntries(
					Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : (v ?? "")]),
				),
			});
			// First request: 401 (e.g. a server-revoked but not-yet-expired
			// token). Second: the forced refresh took effect.
			if (requests.length === 1) {
				res.writeHead(401, { "content-type": "application/json" });
				res.end('{"error":"Unauthorized"}');
				return;
			}
			res.writeHead(200, { "content-type": "text/event-stream" });
			res.end('data: {"id":"1","object":"chat.completion.chunk","created":1,"model":"fake","choices":[{"index":0,"delta":{"content":"ok"},"finish_reason":"stop"}],"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0,"cost":0}}\n\ndata: [DONE]\n\n');
		});
	});
	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));

	// The refresh endpoint: answer the forced refresh with rotated tokens.
	const refreshCalls: string[] = [];
	const fakeConsole = createServer((_req, res) => {
		let body = "";
		_req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
		_req.on("end", () => {
			refreshCalls.push(body);
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ access_token: "at-fresh", refresh_token: "rt-fresh", expires_in: 3600 }));
		});
	});
	await new Promise<void>((r) => fakeConsole.listen(0, "127.0.0.1", r));
	const consoleUrl = `http://127.0.0.1:${(fakeConsole.address() as AddressInfo).port}`;

	try {
		await withAuthFile(
			{
				"opencode-console": {
					type: "oauth",
					refresh: "rt-401",
					access: "at-401",
					expires: Date.now() + 60 * 60_000,
					env: {
						// The stored session must point at the LOCAL fake console
						// so the 401-triggered refresh never leaves localhost.
						OPENCODE_CONSOLE_SERVER: consoleUrl,
						OPENCODE_CONSOLE_ACCOUNT_ID: "acct",
						OPENCODE_CONSOLE_EMAIL: "u@example.test",
						OPENCODE_CONSOLE_ORG_ID: "org-1",
					},
				},
			},
			async () => {
				const model = {
					id: "m",
					name: "M",
					api: "openai-completions",
					provider: "opencode-console",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
				};
				for await (const event of streamSimple(model, { systemPrompt: "x", messages: [] })) {
					assert.ok(event.type !== "error", JSON.stringify(event));
				}
			},
		);
	} finally {
		fakeConsole.closeAllConnections();
		await new Promise<void>((r) => fakeConsole.close(() => r()));
		server.closeAllConnections();
		await new Promise<void>((r) => server.close(() => r()));
	}

	assert.equal(requests.length, 2);
	assert.equal(requests[0]!.headers["authorization"], "Bearer at-401");
	assert.equal(requests[1]!.headers["authorization"], "Bearer at-fresh");
	assert.equal(refreshCalls.length, 1);
	assert.ok(refreshCalls[0]!.includes("rt-401"));
});

test("sharedRefreshToken falls back to a healthy sibling entry when the console refresh token is dead", async () => {
	const pi = makeFakePi();
	providerFactory(cast(pi));
	const provider = pi.providers[0]!;
	const oauth = provider.config.oauth as {
		refreshToken: (c: unknown, signal: AbortSignal) => Promise<{ refresh: string; access: string; expires: number; env?: Record<string, string> }>;
	};

	// The refresh endpoint: dead tokens 400, live tokens rotate.
	const refreshAttempts: string[] = [];
	const fakeConsole = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
		req.on("end", () => {
			refreshAttempts.push(body);
			// Distinguish lineages by the refresh_token in the POST body.
			const dead = body.includes("rt-dead");
			if (dead) {
				res.writeHead(400, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: "invalid_grant" }));
				return;
			}
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ access_token: "at-rotated", refresh_token: "rt-rotated", expires_in: 3600 }));
		});
	});
	await new Promise<void>((r) => fakeConsole.listen(0, "127.0.0.1", r));
	const consoleUrl = `http://127.0.0.1:${(fakeConsole.address() as AddressInfo).port}`;

	// Console entry: stale (dead) refresh lineage. Go entry: fresh lineage.
	try {
		await withAuthFile(
			{
				"opencode-console": {
					type: "oauth",
					refresh: "rt-dead",
					access: "at-dead",
					expires: Date.now() + 30 * 60_000, // fresher by the heuristic…
					env: { OPENCODE_CONSOLE_SERVER: consoleUrl, OPENCODE_CONSOLE_ORG_ID: "org-old" },
				},
				"opencode-go-console": {
					type: "oauth",
					refresh: "rt-alive",
					access: "at-alive",
					expires: Date.now() + 10 * 60_000,
					env: { OPENCODE_CONSOLE_SERVER: consoleUrl, OPENCODE_CONSOLE_ORG_ID: "org-go" },
				},
			},
			async () => {
				const authPath = join(process.env.HOME!, ".pi", "agent", "auth.json");
				const out = await oauth.refreshToken({ refresh: "x", access: "y", expires: 0 }, new AbortController().signal);
				assert.equal(out.access, "at-rotated");
				assert.equal(out.refresh, "rt-rotated");
				// The dead console lineage was tried first, then the go entry succeeded.
				assert.equal(refreshAttempts.length, 2);
				assert.ok(refreshAttempts.some((b) => b.includes("rt-dead")));
				assert.ok(refreshAttempts.some((b) => b.includes("rt-alive")));
				// Convergence: the failed console entry was rewritten with the
				// rotated tokens (its own org env preserved; the go entry rotated).
				const after = JSON.parse(await readFile(authPath, "utf8")) as Record<string, { access: string; refresh: string; expires: number; env?: Record<string, string> }>;
				assert.equal(after["opencode-console"]!.access, "at-rotated");
				assert.equal(after["opencode-console"]!.refresh, "rt-rotated");
				assert.equal(after["opencode-console"]!.env!.OPENCODE_CONSOLE_ORG_ID, "org-old");
				assert.equal(after["opencode-go-console"]!.access, "at-rotated");
				assert.equal(after["opencode-go-console"]!.env!.OPENCODE_CONSOLE_ORG_ID, "org-go");
			},
		);
	} finally {
		fakeConsole.closeAllConnections();
		await new Promise<void>((r) => fakeConsole.close(() => r()));
	}
});
