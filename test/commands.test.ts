import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import providerFactory from "../src/index.ts";

const cast = (x: unknown) => x as never;

interface NotifyCall {
	message: string;
	level: string;
}

function makeHarness() {
	const commands: { name: string; handler: (args: string, ctx: unknown) => Promise<void> }[] = [];
	const notifies: NotifyCall[] = [];
	const selects: { title: string }[] = [];
	const pi = {
		registerProvider: () => {},
		registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			commands.push({ name, handler: options.handler });
		},
	};
	const ctx = {
		ui: {
			notify: (message: string, level: string) => {
				notifies.push({ message, level });
			},
			select: (_title: string, _labels: string[]) => Promise.resolve(undefined),
		},
	};
	providerFactory(cast(pi));
	const handler = (args: string) => commands[0]!.handler(args, cast(ctx));
	void selects;
	return { handler, notifies };
}

async function withAuthFile(
	content: object,
	fn: () => Promise<void>,
): Promise<void> {
	const dir = join(tmpdir(), `pi-opencode-cmd-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const fakeHome = join(dir, "home");
	await mkdir(join(fakeHome, ".pi", "agent"), { recursive: true });
	await writeFile(join(fakeHome, ".pi", "agent", "auth.json"), JSON.stringify(content), { mode: 0o600 });
	const prevHome = process.env.HOME;
	process.env.HOME = fakeHome;
	try {
		await fn();
	} finally {
		if (prevHome === undefined) {
			delete process.env.HOME;
		} else {
			process.env.HOME = prevHome;
		}
		await rm(dir, { recursive: true, force: true });
	}
}

const oauthEntry = {
	type: "oauth",
	refresh: "rt",
	access: "at",
	expires: Date.now() + 60 * 60_000,
	env: {
		OPENCODE_CONSOLE_SERVER: "https://console.example.test",
		OPENCODE_CONSOLE_ACCOUNT_ID: "acct",
		OPENCODE_CONSOLE_EMAIL: "dev@example.test",
		OPENCODE_CONSOLE_ORG_ID: "org-1",
		OPENCODE_CONSOLE_ORG_NAME: "Org One",
	},
};

test("status reports a device-code session for oauth credentials", async () => {
	const { handler, notifies } = makeHarness();
	await withAuthFile({ "opencode-console": oauthEntry }, async () => {
		await handler("");
	});
	assert.equal(notifies.length, 1);
	assert.match(notifies[0]!.message, /Auth: device-code \(OAuth\) session/);
	assert.match(notifies[0]!.message, /dev@example\.test/);
});

test("status treats a legacy service-key entry as signed out", async () => {
	const { handler, notifies } = makeHarness();
	await withAuthFile(
		{ "opencode-console": { type: "api_key", key: "sk-abcdef0123456789abcdef0123456789" } },
		async () => {
			await handler("");
		},
	);
	// Service-key auth was removed in 2.0: the entry is inert.
	assert.match(notifies[0]!.message, /Not signed in/);
});

test("status warns when no credential is stored", async () => {
	const { handler, notifies } = makeHarness();
	await withAuthFile({}, async () => {
		await handler("");
	});
	assert.match(notifies[0]!.message, /Not signed in/);
});

test("logout removes the stored credential (even a legacy service key)", async () => {
	const { handler, notifies } = makeHarness();
	let authAfterLogout: Record<string, unknown> | undefined;
	await withAuthFile(
		{
			"opencode-console": {
				type: "oauth",
				refresh: "rt",
				access: "at",
				expires: Date.now() + 60 * 60_000,
			},
			"opencode-go-console": { type: "api_key", key: "sk-logout-key-1234567890" },
		},
		async () => {
			const authPath = join(process.env.HOME!, ".pi", "agent", "auth.json");
			await handler("logout");
			authAfterLogout = JSON.parse(await readFile(authPath, "utf8")) as Record<string, unknown>;
		},
	);
	assert.match(notifies[0]!.message, /Signed out/);
	assert.ok(authAfterLogout);
	assert.ok(!("opencode-console" in authAfterLogout!));
	// The go slot's legacy service key is untouched by a console logout.
	assert.ok("opencode-go-console" in authAfterLogout!);
});

test("switch-org treats a legacy service-key entry as signed out", async () => {
	const { handler, notifies } = makeHarness();
	await withAuthFile(
		{ "opencode-console": { type: "api_key", key: "sk-org-key-1234567890" } },
		async () => {
			await handler("switch-org");
		},
	);
	assert.equal(notifies[0]!.level, "warning");
	assert.match(notifies[0]!.message, /Not signed in/);
});

test("switch-org is rejected for a server-scoped session", async () => {
	const { handler, notifies } = makeHarness();
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
					OPENCODE_CONSOLE_EMAIL: "dev@example.test",
					OPENCODE_CONSOLE_ORG_ID: "org-a",
					OPENCODE_CONSOLE_ORG_NAME: "Alpha",
					OPENCODE_CONSOLE_SCOPED_ORG_ID: "org-a",
				},
			},
		},
		async () => {
			await handler("switch-org");
		},
	);
	assert.equal(notifies[0]!.level, "warning");
	assert.match(notifies[0]!.message, /scoped to the organization chosen at sign-in/);
});
// --- OpenCode Go command (opencode-go-console) ---

const goApiEntry = {
	type: "oauth",
	refresh: "rt-go",
	access: "at-go",
	expires: Date.now() + 60 * 60_000,
	env: {
		OPENCODE_CONSOLE_SERVER: "https://console.example.test",
		OPENCODE_CONSOLE_ACCOUNT_ID: "acct-go",
		OPENCODE_CONSOLE_EMAIL: "go@example.test",
		OPENCODE_CONSOLE_ORG_ID: "org-go",
		OPENCODE_CONSOLE_ORG_NAME: "Org Go",
	},
};

interface GoHarness {
	handler: (args: string) => Promise<void>;
	notifies: NotifyCall[];
}

function makeGoHarness(): GoHarness {
	const commands: { name: string; handler: (args: string, ctx: unknown) => Promise<void> }[] = [];
	const notifies: NotifyCall[] = [];
	const pi = {
		registerProvider: () => {},
		registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) {
			commands.push({ name, handler: options.handler });
		},
	};
	const ctx = {
		ui: {
			notify: (message: string, level: string) => {
				notifies.push({ message, level });
			},
			select: (_title: string, _labels: string[]) => Promise.resolve(undefined),
		},
	};
	providerFactory(cast(pi));
	const goIdxFind = commands.findIndex((c) => c.name === "opencode-go-console");
	const handler = (args: string) => commands[goIdxFind]!.handler(args, cast(ctx));
	return { handler, notifies };
}

test("go status reports the shared console session", async () => {
	const { handler, notifies } = makeGoHarness();
	await withAuthFile({ "opencode-go-console": goApiEntry }, async () => {
		await handler("");
	});
	assert.match(notifies[0]!.message, /OpenCode Go status/);
	assert.match(notifies[0]!.message, /device-code \(OAuth\) session/);
	assert.match(notifies[0]!.message, /go@example\.test/);
});

test("go logout preserves the console device session", async () => {
	const { handler, notifies } = makeGoHarness();
	let authAfter: Record<string, unknown> | undefined;
	await withAuthFile(
		{
			"opencode-console": {
				type: "oauth",
				refresh: "rt-console",
				access: "at-console",
				expires: Date.now() + 60 * 60_000,
			},
			"opencode-go-console": {
				type: "oauth",
				refresh: "rt-go",
				access: "at-go",
				expires: Date.now() + 60 * 60_000,
			},
		},
		async () => {
			const authPath = join(process.env.HOME!, ".pi", "agent", "auth.json");
			await handler("logout");
			authAfter = JSON.parse(await readFile(authPath, "utf8")) as Record<string, unknown>;
		},
	);
	assert.match(notifies[0]!.message, /Signed out of OpenCode Go/);
	assert.ok(authAfter);
	// Go entry removed; the shared Console session is intentionally preserved.
	assert.ok(!("opencode-go-console" in authAfter!));
	assert.ok("opencode-console" in authAfter!);
});

test("go refresh uses the public Go /models catalog for session creds", async () => {
	const { handler, notifies } = makeGoHarness();
	const prevFetch = globalThis.fetch;
	const urls: string[] = [];
	globalThis.fetch = (async (input, init) => {
		const url = String(input);
		if (url.includes("models.dev")) return new Response("{}", { status: 200 });
		urls.push(url);
		void init;
		return new Response(JSON.stringify({ data: [{ id: "go-model", name: "GoModel" }] }), { status: 200 });
	}) as typeof fetch;
	try {
		await withAuthFile({ "opencode-go-console": goApiEntry }, async () => {
			await handler("refresh");
		});
	} finally {
		globalThis.fetch = prevFetch;
	}
	assert.match(notifies[0]!.message, /Found 1 models/);
	assert.ok(urls[0]!.endsWith("/zen/go/v1/models"), urls[0]);
});
