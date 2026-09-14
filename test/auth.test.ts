import test from "node:test";
import assert from "node:assert/strict";
import {
	requestDeviceCode,
	completeDeviceSignIn,
	refreshSession,
	ensureFreshSession,
	resolveConsoleVerificationUrl,
	isPublicConsoleServer,
	DEFAULT_CONSOLE_SERVER,
} from "../src/auth.ts";

const SERVER = "https://console.example.test";
const COMPLETE = "/console/device?user_code=ABCD-EFGH&client_id=opencode-cli";
const EXPECTED = "https://opencode.ai/console/device?user_code=ABCD-EFGH&client_id=opencode-cli";

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
	assert.equal(session.orgId, "org-1"); // sorted alphabetically
	assert.equal(session.orgName, "Alpha");
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
