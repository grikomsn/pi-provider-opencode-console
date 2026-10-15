import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	requestDeviceCode,
	completeDeviceSignIn,
	refreshSession,
	ensureFreshSession,
	resolveConsoleVerificationUrl,
	isPublicConsoleServer,
	loadSession,
	saveSession,
	envForSession,
	DEFAULT_CONSOLE_SERVER,
	PROVIDER_ID,
} from "../src/auth.ts";

const SERVER = "https://console.example.test";
const COMPLETE = "/console/device?user_code=ABCD-EFGH&client_id=opencode-cli";
const EXPECTED = "https://opencode.ai/console/device?user_code=ABCD-EFGH&client_id=opencode-cli";

test("session storage respects PI_CODING_AGENT_DIR", async () => {
	const agentDir = await mkdtemp(join(tmpdir(), "pi-opencode-isolated-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		await saveSession({
			server: DEFAULT_CONSOLE_SERVER,
			accessToken: "isolated-access",
			refreshToken: "isolated-refresh",
			expiresAt: Date.now() + 3_600_000,
			accountId: "isolated-account",
			email: "user@example.test",
			orgs: [],
		});
		const auth = JSON.parse(await readFile(join(agentDir, "auth.json"), "utf8"));
		assert.equal(auth[PROVIDER_ID].access, "isolated-access");
		assert.equal((await loadSession())?.accessToken, "isolated-access");
		await deleteSession();
		assert.equal(await loadSession(), undefined);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(agentDir, { recursive: true, force: true });
	}
});

test("resolves Console device verification URLs onto the /console subpath", () => {
	assert.equal(resolveConsoleVerificationUrl(DEFAULT_CONSOLE_SERVER, COMPLETE), EXPECTED);
	assert.equal(resolveConsoleVerificationUrl("https://opencode.ai/console/", COMPLETE), EXPECTED);
	assert.equal(
		resolveConsoleVerificationUrl(DEFAULT_CONSOLE_SERVER, "device?user_code=ABCD-EFGH"),
		"https://opencode.ai/console/device?user_code=ABCD-EFGH",
	);
	assert.equal(resolveConsoleVerificationUrl(DEFAULT_CONSOLE_SERVER, EXPECTED), EXPECTED);
});

test("rewrites console.opencode.ai device pages onto opencode.ai/console", () => {
	assert.equal(resolveConsoleVerificationUrl("https://console.opencode.ai", COMPLETE), EXPECTED);
	assert.equal(resolveConsoleVerificationUrl("https://console.opencode.ai/", COMPLETE), EXPECTED);
	assert.equal(
		resolveConsoleVerificationUrl("https://console.opencode.ai", "/device?user_code=ABCD-EFGH"),
		"https://opencode.ai/console/device?user_code=ABCD-EFGH",
	);
	assert.equal(
		resolveConsoleVerificationUrl(
			DEFAULT_CONSOLE_SERVER,
			"https://console.opencode.ai/console/device?user_code=ABCD-EFGH",
		),
		"https://opencode.ai/console/device?user_code=ABCD-EFGH",
	);
});

test("rejects non-HTTP Console verification URLs", () => {
	assert.throws(() => resolveConsoleVerificationUrl(DEFAULT_CONSOLE_SERVER, "javascript:alert(1)"), /non-HTTP/);
	assert.throws(() => resolveConsoleVerificationUrl(DEFAULT_CONSOLE_SERVER, "http://["), /invalid verification URL/);
});

test("isPublicConsoleServer treats both public hosts as default", () => {
	assert.equal(isPublicConsoleServer(DEFAULT_CONSOLE_SERVER), true);
	assert.equal(isPublicConsoleServer("https://console.opencode.ai"), true);
	assert.equal(isPublicConsoleServer("https://console.opencode.ai/"), true);
	assert.equal(isPublicConsoleServer(SERVER), false);
});

test("requestDeviceCode parses response", async () => {
	const fetcher: typeof fetch = async () =>
		new Response(
			JSON.stringify({
				device_code: "dev-123",
				user_code: "ABCD-1234",
				verification_uri_complete: "https://console.example.test/activate?code=ABCD-1234",
				expires_in: 600,
				interval: 5,
			}),
			{ status: 200 },
		);
	const dc = await requestDeviceCode(SERVER, fetcher);
	assert.equal(dc.deviceCode, "dev-123");
	assert.equal(dc.userCode, "ABCD-1234");
	assert.equal(dc.verificationUrl, "https://console.example.test/activate?code=ABCD-1234");
	assert.equal(dc.server, SERVER);
	assert.ok(dc.expiresAt > Date.now() + 599_000);
	assert.equal(dc.intervalMs, 5000);
});

test("requestDeviceCode opts in to organization scoping", async () => {
	let body: Record<string, unknown> | undefined;
	const fetcher: typeof fetch = async (_input, init) => {
		body = JSON.parse(String(init?.body)) as Record<string, unknown>;
		return new Response(
			JSON.stringify({
				device_code: "d",
				user_code: "ABCD",
				verification_uri_complete: "https://console.example.test/activate?code=ABCD",
				expires_in: 600,
				interval: 5,
			}),
			{ status: 200 },
		);
	};
	await requestDeviceCode(SERVER, fetcher);
	assert.equal(body?.supports_org_scope, true);
	assert.equal(body?.client_id, "opencode-cli");
});

test("requestDeviceCode opens verification at opencode.ai/console/device", async () => {
	const fetcher: typeof fetch = async (input) => {
		assert.equal(String(input), "https://opencode.ai/console/auth/device/code");
		return new Response(
			JSON.stringify({
				device_code: "device",
				user_code: "ABCD-EFGH",
				verification_uri: "/console/device",
				verification_uri_complete: COMPLETE,
				expires_in: 900,
				interval: 5,
			}),
			{ status: 200 },
		);
	};
	const dc = await requestDeviceCode(DEFAULT_CONSOLE_SERVER, fetcher);
	assert.equal(dc.verificationUrl, EXPECTED);
	assert.equal(dc.server, DEFAULT_CONSOLE_SERVER);
	assert.equal(dc.userCode, "ABCD-EFGH");
});

test("requestDeviceCode rewrites console.opencode.ai device pages but keeps the API server", async () => {
	const fetcher: typeof fetch = async (input) => {
		assert.equal(String(input), "https://console.opencode.ai/auth/device/code");
		return new Response(
			JSON.stringify({
				device_code: "device",
				user_code: "WXYZ-UVST",
				verification_uri_complete: "/console/device?user_code=WXYZ-UVST",
				expires_in: 900,
				interval: 5,
			}),
			{ status: 200 },
		);
	};
	const dc = await requestDeviceCode("https://console.opencode.ai", fetcher);
	assert.equal(dc.verificationUrl, "https://opencode.ai/console/device?user_code=WXYZ-UVST");
	assert.equal(dc.server, "https://console.opencode.ai");
});

test("requestDeviceCode throws on incomplete response", async () => {
	const fetcher: typeof fetch = async () =>
		new Response(JSON.stringify({ device_code: "x" }), { status: 200 });
	await assert.rejects(requestDeviceCode(SERVER, fetcher), /incomplete device-code/);
});

test("completeDeviceSignIn polls past authorization_pending", async () => {
	let calls = 0;
	const fetcher: typeof fetch = async (input) => {
		const url = String(input);
		if (url.endsWith("/auth/device/token")) {
			calls += 1;
			if (calls === 1) return new Response(JSON.stringify({ error: "authorization_pending" }), { status: 200 });
			return new Response(
				JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600 }),
				{ status: 200 },
			);
		}
		if (url.endsWith("/api/user")) return new Response(JSON.stringify({ id: "u1", email: "u@example.test" }));
		if (url.endsWith("/api/orgs"))
			return new Response(JSON.stringify([{ id: "org-2", name: "Beta" }, { id: "org-1", name: "Alpha" }]));
		throw new Error("unexpected url: " + url);
	};
	const device = {
		deviceCode: "d",
		userCode: "ABCD",
		verificationUrl: "https://x",
		expiresAt: Date.now() + 60_000,
		intervalMs: 1,
		server: SERVER,
	};
	const session = await completeDeviceSignIn(device, { fetcher, sleep: async () => {} });
	assert.equal(session.accountId, "u1");
	assert.equal(session.email, "u@example.test");
	// Multi-org account without a server scope: no silent first-org pin —
	// the login flow prompts for an explicit pick when orgId is unset.
	assert.equal(session.orgId, undefined);
	assert.equal(session.orgName, undefined);
	assert.equal(session.scopedOrgId, undefined);
});

test("completeDeviceSignIn honors a server-scoped org grant", async () => {
	const fetcher: typeof fetch = async (input) => {
		const url = String(input);
		if (url.endsWith("/auth/device/token")) {
			return new Response(
				JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600, org_id: "org-1" }),
				{ status: 200 },
			);
		}
		if (url.endsWith("/api/user")) return new Response(JSON.stringify({ id: "u1", email: "u@example.test" }));
		if (url.endsWith("/api/orgs"))
			return new Response(JSON.stringify([{ id: "org-2", name: "Beta" }, { id: "org-1", name: "Alpha" }]));
		throw new Error("unexpected url: " + url);
	};
	const device = {
		deviceCode: "d",
		userCode: "ABCD",
		verificationUrl: "https://x",
		expiresAt: Date.now() + 60_000,
		intervalMs: 1,
		server: SERVER,
	};
	const session = await completeDeviceSignIn(device, { fetcher, sleep: async () => {} });
	assert.equal(session.orgId, "org-1");
	assert.equal(session.orgName, "Alpha");
	assert.equal(session.scopedOrgId, "org-1");
});

test("completeDeviceSignIn fails on an unknown granted org", async () => {
	const fetcher: typeof fetch = async (input) => {
		const url = String(input);
		if (url.endsWith("/auth/device/token")) {
			return new Response(
				JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600, org_id: "org-x" }),
				{ status: 200 },
			);
		}
		if (url.endsWith("/api/user")) return new Response(JSON.stringify({ id: "u1", email: "u@example.test" }));
		if (url.endsWith("/api/orgs")) return new Response(JSON.stringify([{ id: "org-1", name: "Alpha" }]));
		throw new Error("unexpected url: " + url);
	};
	const device = {
		deviceCode: "d",
		userCode: "ABCD",
		verificationUrl: "https://x",
		expiresAt: Date.now() + 60_000,
		intervalMs: 1,
		server: SERVER,
	};
	await assert.rejects(
		completeDeviceSignIn(device, { fetcher, sleep: async () => {} }),
		/granted a session for an unavailable organization/,
	);
});

test("completeDeviceSignIn auto-selects a single-org account without a grant", async () => {
	const fetcher: typeof fetch = async (input) => {
		const url = String(input);
		if (url.endsWith("/auth/device/token")) {
			return new Response(JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600 }), {
				status: 200,
			});
		}
		if (url.endsWith("/api/user")) return new Response(JSON.stringify({ id: "u1", email: "u@example.test" }));
		if (url.endsWith("/api/orgs")) return new Response(JSON.stringify([{ id: "org-1", name: "Alpha" }]));
		throw new Error("unexpected url: " + url);
	};
	const device = {
		deviceCode: "d",
		userCode: "ABCD",
		verificationUrl: "https://x",
		expiresAt: Date.now() + 60_000,
		intervalMs: 1,
		server: SERVER,
	};
	const session = await completeDeviceSignIn(device, { fetcher, sleep: async () => {} });
	assert.equal(session.orgId, "org-1");
	assert.equal(session.orgName, "Alpha");
	assert.equal(session.scopedOrgId, undefined);
});

test("completeDeviceSignIn handles slow_down", async () => {
	let calls = 0;
	const fetcher: typeof fetch = async (input) => {
		const url = String(input);
		if (url.endsWith("/auth/device/token")) {
			calls += 1;
			if (calls === 1) return new Response(JSON.stringify({ error: "slow_down" }), { status: 200 });
			return new Response(
				JSON.stringify({ access_token: "at", refresh_token: "rt", expires_in: 3600 }),
				{ status: 200 },
			);
		}
		if (url.endsWith("/api/user")) return new Response(JSON.stringify({ id: "u", email: "e@e.test" }));
		if (url.endsWith("/api/orgs")) return new Response(JSON.stringify([]));
		throw new Error("nope");
	};
	const device = {
		deviceCode: "d",
		userCode: "X",
		verificationUrl: "x",
		expiresAt: Date.now() + 60_000,
		intervalMs: 1,
		server: SERVER,
	};
	const session = await completeDeviceSignIn(device, { fetcher, sleep: async () => {} });
	assert.equal(session.accessToken, "at");
});

test("completeDeviceSignIn surfaces access_denied", async () => {
	const fetcher: typeof fetch = async () =>
		new Response(JSON.stringify({ error: "access_denied" }), { status: 200 });
	const device = {
		deviceCode: "d",
		userCode: "X",
		verificationUrl: "x",
		expiresAt: Date.now() + 60_000,
		intervalMs: 1,
		server: SERVER,
	};
	await assert.rejects(completeDeviceSignIn(device, { fetcher, sleep: async () => {} }), /denied/);
});

test("refreshSession rotates tokens", async () => {
	const fetcher: typeof fetch = async () =>
		new Response(
			JSON.stringify({ access_token: "new-at", refresh_token: "new-rt", expires_in: 7200 }),
			{ status: 200 },
		);
	const next = await refreshSession(
		{
			server: SERVER,
			accessToken: "old",
			refreshToken: "old-rt",
			expiresAt: 0,
			accountId: "u",
			email: "e@e.test",
			orgs: [],
		},
		fetcher,
	);
	assert.equal(next.accessToken, "new-at");
	assert.equal(next.refreshToken, "new-rt");
	assert.ok(next.expiresAt > Date.now() + 7000_000);
});

test("refreshSession keeps a scoped session's org and rejects scope changes", async () => {
	const base = {
		server: SERVER,
		accessToken: "old",
		refreshToken: "rt",
		expiresAt: Date.now() - 1000,
		accountId: "a",
		email: "e",
		orgs: [{ id: "org-1", name: "Alpha" }, { id: "org-2", name: "Beta" }],
		orgId: "org-1",
		orgName: "Alpha",
		scopedOrgId: "org-1",
	};
	// Omitted org_id keeps the scope.
	const kept = await refreshSession(
		base,
		async () => new Response(JSON.stringify({ access_token: "new", refresh_token: "rt2", expires_in: 3600 }), { status: 200 }),
	);
	assert.equal(kept.orgId, "org-1");
	assert.equal(kept.scopedOrgId, "org-1");
	// Same org_id keeps the scope.
	const same = await refreshSession(
		base,
		async () => new Response(JSON.stringify({ access_token: "new", refresh_token: "rt2", expires_in: 3600, org_id: "org-1" }), { status: 200 }),
	);
	assert.equal(same.orgId, "org-1");
	// A different org_id is a hard error.
	await assert.rejects(
		refreshSession(
			base,
			async () => new Response(JSON.stringify({ access_token: "new", refresh_token: "rt2", expires_in: 3600, org_id: "org-2" }), { status: 200 }),
		),
		/changed the session's organization scope/,
	);
});

test("refreshSession adopts a granted org on an un-scoped session", async () => {
	const base = {
		server: SERVER,
		accessToken: "old",
		refreshToken: "rt",
		expiresAt: Date.now() - 1000,
		accountId: "a",
		email: "e",
		orgs: [{ id: "org-1", name: "Alpha" }, { id: "org-2", name: "Beta" }],
	};
	const refreshed = await refreshSession(
		base,
		async () => new Response(JSON.stringify({ access_token: "new", refresh_token: "rt2", expires_in: 3600, org_id: "org-2" }), { status: 200 }),
	);
	assert.equal(refreshed.orgId, "org-2");
	assert.equal(refreshed.orgName, "Beta");
	assert.equal(refreshed.scopedOrgId, undefined);
});

test("ensureFreshSession is single-flight", async () => {
	let calls = 0;
	const fetcher: typeof fetch = async () => {
		calls += 1;
		await new Promise((r) => setTimeout(r, 10));
		return new Response(
			JSON.stringify({ access_token: "x", refresh_token: "y", expires_in: 3600 }),
			{ status: 200 },
		);
	};
	const stale = {
		server: SERVER,
		accessToken: "old",
		refreshToken: "rt",
		expiresAt: Date.now() - 1,
		accountId: "u",
		email: "e",
		orgs: [],
	};
	const [a, b] = await Promise.all([
		ensureFreshSession(stale, false, fetcher),
		ensureFreshSession(stale, false, fetcher),
	]);
	assert.equal(a.accessToken, "x");
	assert.equal(b.accessToken, "x");
	assert.equal(calls, 1);
});

test("ensureFreshSession short-circuits when still fresh", async () => {
	let calls = 0;
	const fetcher: typeof fetch = async () => {
		calls += 1;
		return new Response(JSON.stringify({}), { status: 200 });
	};
	const fresh = {
		server: SERVER,
		accessToken: "still-valid",
		refreshToken: "rt",
		expiresAt: Date.now() + 30 * 60_000,
		accountId: "u",
		email: "e",
		orgs: [],
	};
	const session = await ensureFreshSession(fresh, false, fetcher);
	assert.equal(session.accessToken, "still-valid");
	assert.equal(calls, 0);
});

test("saveSession persists the org list and loadSession restores it", async () => {
	const { mkdtemp, rm } = await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const fakeHome = await mkdtemp(join(tmpdir(), "pi-provider-auth-"));
	const prevHome = process.env.HOME;
	process.env.HOME = fakeHome;
	try {
		const orgs = [
			{ id: "org-b", name: "Beta" },
			{ id: "org-a", name: "Alpha" },
		];
		const sortedOrgs = [...orgs].sort((a, b) => a.name.localeCompare(b.name));
		await saveSession(
			{
				server: DEFAULT_CONSOLE_SERVER,
				accessToken: "at",
				refreshToken: "rt",
				expiresAt: Date.now() + 60 * 60_000,
				accountId: "acct",
				email: "u@example.test",
				orgs: [],
				orgId: "org-a",
				orgName: "Alpha",
				scopedOrgId: "org-a",
			},
			orgs,
		);
		const loaded = await loadSession();
		assert.ok(loaded);
		assert.deepEqual(loaded.orgs, sortedOrgs);
		assert.equal(loaded.orgId, "org-a");
		assert.equal(loaded.orgName, "Alpha");
		// Server-scoped org survives the auth.json round-trip.
		assert.equal(loaded.scopedOrgId, "org-a");

		// envForSession without fetchedOrgs keeps the carried-over org list.
		const env = envForSession(loaded);
		assert.equal(env.OPENCODE_CONSOLE_ORGS, JSON.stringify(sortedOrgs));

		// Corrupt org JSON degrades to an empty list, not a crash.
		const authPath = join(fakeHome, ".pi", "agent", "auth.json");
		const authRaw = await readFile(authPath, "utf8");
		const auth = JSON.parse(authRaw) as Record<string, { env: Record<string, string> }>;
		auth[PROVIDER_ID]!.env!.OPENCODE_CONSOLE_ORGS = "{not json";
		await writeFile(authPath, JSON.stringify(auth));
		const degraded = await loadSession();
		assert.ok(degraded);
		assert.deepEqual(degraded.orgs, []);
	} finally {
		process.env.HOME = prevHome;
		await rm(fakeHome, { recursive: true, force: true });
	}
});

// --- device-only credential resolution (legacy api_key entries are ignored) ---

import {
	deleteSession,
	loadCredential,
	mirrorOAuthTokens,
	GO_PROVIDER_ID,
	type OAuthStoredCredential,
} from "../src/auth.ts";

async function withFakeHome(
	authJson: object,
	fn: () => Promise<void>,
): Promise<void> {
	const fakeHome = join(tmpdir(), `pi-opencode-auth-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	await mkdir(join(fakeHome, ".pi", "agent"), { recursive: true });
	await writeFile(join(fakeHome, ".pi", "agent", "auth.json"), JSON.stringify(authJson), { mode: 0o600 });
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
		await rm(fakeHome, { recursive: true, force: true });
	}
}

test("loadCredential ignores a legacy api_key (service key) entry", async () => {
	await withFakeHome(
		{ [PROVIDER_ID]: { type: "api_key", key: "sk-testkey-abcdef0123456789" } },
		async () => {
			// Service-key auth was removed in 2.0: the entry is inert.
			assert.equal(await loadCredential(), undefined);
		},
	);
});

test("loadCredential rebuilds the oauth session entry", async () => {
	const session = {
		server: "https://console.example.test",
		accessToken: "at",
		refreshToken: "rt",
		expiresAt: Date.now() + 60 * 60_000,
		accountId: "acct",
		email: "u@example.test",
		orgs: [{ id: "org-a", name: "Alpha" }],
		orgId: "org-a",
		orgName: "Alpha",
	};
	await withFakeHome({ [PROVIDER_ID]: await entryFor(session) }, async () => {
		const cred = (await loadCredential()) as OAuthStoredCredential;
		assert.equal(cred.kind, "oauth");
		assert.equal(cred.session.email, "u@example.test");
		assert.equal(cred.session.server, "https://console.example.test");
		assert.equal(cred.session.orgId, "org-a");
		assert.deepEqual(cred.session.orgs, [{ id: "org-a", name: "Alpha" }]);
	});

	function entryFor(s: (typeof session & { orgs: object[] })) {
		return {
			type: "oauth",
			refresh: s.refreshToken,
			access: s.accessToken,
			expires: s.expiresAt,
			env: {
				OPENCODE_CONSOLE_SERVER: s.server,
				OPENCODE_CONSOLE_ACCOUNT_ID: s.accountId,
				OPENCODE_CONSOLE_EMAIL: s.email,
				OPENCODE_CONSOLE_ORGS: JSON.stringify(s.orgs),
				OPENCODE_CONSOLE_ORG_ID: s.orgId ?? "",
				OPENCODE_CONSOLE_ORG_NAME: s.orgName ?? "",
			},
		};
	}
});

test("loadCredential and deleteSession are per-provider-id", async () => {
	await withFakeHome(
		{
			[PROVIDER_ID]: { type: "oauth", refresh: "rt", access: "at", expires: Date.now() + 60 * 60_000 },
			[GO_PROVIDER_ID]: { type: "oauth", refresh: "rt-go", access: "at-go", expires: Date.now() + 60 * 60_000 },
		},
		async () => {
			const consoleCred = (await loadCredential()) as OAuthStoredCredential;
			assert.equal(consoleCred.kind, "oauth");
			const goCred = (await loadCredential(GO_PROVIDER_ID)) as OAuthStoredCredential;
			assert.equal(goCred.kind, "oauth");
			await deleteSession(PROVIDER_ID);
			assert.equal(await loadCredential(), undefined);
			assert.ok(await loadCredential(GO_PROVIDER_ID));
		},
	);
});

test("loadCredential ignores unknown entry types", async () => {
	await withFakeHome({ [PROVIDER_ID]: { type: "wellknown", key: "x", token: "y" } }, async () => {
		assert.equal(await loadCredential(), undefined);
	});
});

test("mirrorOAuthTokens rotates the sibling oauth entry (tokens + env)", async () => {
	await withFakeHome(
		{
			[PROVIDER_ID]: { type: "oauth", refresh: "rt-old", access: "at-old", expires: 1 },
			[GO_PROVIDER_ID]: {
				type: "oauth",
				refresh: "rt-go-old",
				access: "at-go-old",
				expires: 2,
				env: { OPENCODE_CONSOLE_ORG_ID: "org-go-stale" },
			},
		},
		async () => {
			const session = {
				server: "https://console.example.test",
				accessToken: "at-new",
				refreshToken: "rt-new",
				expiresAt: Date.now() + 60 * 60_000,
				accountId: "acct",
				email: "u@example.test",
				orgs: [{ id: "org-a", name: "Alpha" }],
				orgId: "org-a",
				orgName: "Alpha",
			};
			await mirrorOAuthTokens(session, PROVIDER_ID, GO_PROVIDER_ID);
			const goCred = (await loadCredential(GO_PROVIDER_ID)) as OAuthStoredCredential;
			assert.equal(goCred.kind, "oauth");
			assert.equal(goCred.session.accessToken, "at-new");
			assert.equal(goCred.session.refreshToken, "rt-new");
			// Token fields only: the sibling's own env (org choice) survives.
			assert.equal(goCred.session.orgId, "org-go-stale");
			// Console entry untouched.
			const consoleCred = (await loadCredential()) as OAuthStoredCredential;
			assert.equal(consoleCred.session.refreshToken, "rt-old");
		},
	);
});

test("mirrorOAuthTokens skips missing and non-oauth siblings", async () => {
	await withFakeHome(
		{ [PROVIDER_ID]: { type: "oauth", refresh: "rt", access: "at", expires: 1 } },
		async () => {
			const session = {
				server: DEFAULT_CONSOLE_SERVER,
				accessToken: "n",
				refreshToken: "r",
				expiresAt: 9,
				accountId: "a",
				email: "e",
				orgs: [],
			};
			// Missing sibling: no entry created, no throw.
			await mirrorOAuthTokens(session, PROVIDER_ID, "nonexistent");
			assert.equal(await loadCredential("nonexistent"), undefined);
			// Non-oauth sibling (legacy api_key shape): untouched.
			// (Write an api_key entry, mirror, verify it stays.)
			const raw = await readFile(join(process.env.HOME!, ".pi", "agent", "auth.json"), "utf8");
			const auth = JSON.parse(raw) as Record<string, Record<string, unknown>>;
			auth["opencode-key-slot"] = { type: "api_key", key: "sk-x-123456789011" };
			await writeFile(join(process.env.HOME!, ".pi", "agent", "auth.json"), JSON.stringify(auth), { mode: 0o600 });
			await mirrorOAuthTokens(session, PROVIDER_ID, "opencode-key-slot");
			const after = JSON.parse(
				await readFile(join(process.env.HOME!, ".pi", "agent", "auth.json"), "utf8"),
			) as Record<string, { type: string; key?: string }>;
			assert.equal(after["opencode-key-slot"]!.type, "api_key");
			assert.equal(after["opencode-key-slot"]!.key, "sk-x-123456789011");
		},
	);
});
