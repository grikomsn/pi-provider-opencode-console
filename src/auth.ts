/**
 * OpenCode Console device-auth flow + auth.json persistence.
 *
 * Implements the OAuth 2.0 device authorization grant (RFC 8628) against
 * the OpenCode Console server, persists credentials in the standard pi
 * auth.json file (so `/logout opencode-console` works automatically), and
 * provides single-flight refresh-on-demand for use during chat requests.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// Public Console is served at https://opencode.ai/console. The console.opencode.ai
// alias 302-prefixes /console, so using it as a browser origin doubles that path.
export const DEFAULT_CONSOLE_SERVER = "https://opencode.ai/console";
export const CONSOLE_ALIAS_HOST = "console.opencode.ai";
export const OPENCODE_CLIENT_ID = "opencode-cli";
export const OPENCODE_CLIENT = "pi-provider-opencode-console";
export const PROVIDER_ID = "opencode-console";

/**
 * Resolve the auth.json location lazily so tests can redirect `HOME`
 * before the first call. The previous top-level constant captured the
 * path at module load, which broke `loadSession` after env changes.
 */
function authDir(): string {
	return join(homedir(), ".pi", "agent");
}
function authFile(): string {
	return join(authDir(), "auth.json");
}

export interface ConsoleOrg {
	id: string;
	name: string;
}

export interface ConsoleSession {
	server: string;
	accessToken: string;
	refreshToken: string;
	/** Epoch milliseconds at which the access token expires. */
	expiresAt: number;
	accountId: string;
	email: string;
	orgs: ConsoleOrg[];
	orgId?: string;
	orgName?: string;
}

export interface DeviceCode {
	deviceCode: string;
	userCode: string;
	verificationUrl: string;
	/** Epoch milliseconds at which the device code stops being accepted. */
	expiresAt: number;
	/** Minimum polling interval, milliseconds. */
	intervalMs: number;
	server: string;
}

export interface DeviceCodeInfo {
	userCode: string;
	verificationUri: string;
	intervalSeconds?: number;
	expiresInSeconds?: number;
}

export interface AuthCallbacks {
	onDeviceCode?: (info: DeviceCodeInfo) => void;
	onProgress?: (message: string) => void;
	signal?: AbortSignal;
	fetcher?: typeof fetch;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
	new Promise<void>((resolve, reject) => {
		const t = setTimeout(resolve, ms);
		if (signal) {
			const onAbort = () => {
				clearTimeout(t);
				reject(new Error("aborted"));
			};
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		}
	});

function stringField(obj: Record<string, unknown> | undefined, key: string): string | undefined {
	const v = obj?.[key];
	return typeof v === "string" ? v : undefined;
}

function positiveNumber(obj: Record<string, unknown> | undefined, key: string, fallback: number): number {
	const v = obj?.[key];
	return typeof v === "number" && v > 0 ? v : fallback;
}

function normalizeOrgs(raw: unknown): ConsoleOrg[] {
	if (!Array.isArray(raw)) return [];
	const orgs: ConsoleOrg[] = [];
	for (const item of raw) {
		if (item && typeof item === "object") {
			const o = item as Record<string, unknown>;
			const id = stringField(o, "id");
			const name = stringField(o, "name");
			if (id && name) orgs.push({ id, name });
		}
	}
	// Stable sort: name asc, id asc (deterministic ordering for UI).
	orgs.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
	return orgs;
}

async function getJson(
	fetcher: typeof fetch,
	url: string,
	token: string,
	signal?: AbortSignal,
): Promise<Record<string, unknown>> {
	const response = await fetcher(url, {
		headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
		signal,
	});
	if (!response.ok) throw new Error(`GET ${url} failed (${response.status})`);
	return (await response.json()) as Record<string, unknown>;
}

function stripTrailingSlash(server: string): string {
	return server.replace(/\/+$/, "");
}

export function isPublicConsoleServer(server: string): boolean {
	const normalized = stripTrailingSlash(server);
	return normalized === DEFAULT_CONSOLE_SERVER || normalized === `https://${CONSOLE_ALIAS_HOST}`;
}

/**
 * Resolve `verification_uri_complete` against the Console API base.
 * The live API returns an origin-absolute `/console/device?...` path; string
 * concatenation onto either public host doubles `/console`.
 */
export function resolveConsoleVerificationUrl(server: string, verification: string): string {
	let url: URL;
	try {
		url = new URL(verification, `${stripTrailingSlash(server)}/`);
	} catch {
		throw new Error("OpenCode Console returned an invalid verification URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("OpenCode Console returned a non-HTTP verification URL");
	}
	return canonicalizePublicConsoleUrl(url).href;
}

function canonicalizePublicConsoleUrl(url: URL): URL {
	if (url.hostname !== CONSOLE_ALIAS_HOST) return url;
	const next = new URL(url.href);
	next.hostname = "opencode.ai";
	if (next.pathname !== "/console" && !next.pathname.startsWith("/console/")) {
		next.pathname = `/console${next.pathname.startsWith("/") ? next.pathname : `/${next.pathname}`}`;
	}
	return next;
}

export async function requestDeviceCode(
	server: string = DEFAULT_CONSOLE_SERVER,
	fetcher: typeof fetch = fetch,
): Promise<DeviceCode> {
	const normalized = stripTrailingSlash(server);
	const response = await fetcher(`${normalized}/auth/device/code`, {
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/json" },
		body: JSON.stringify({ client_id: OPENCODE_CLIENT_ID }),
	});
	if (!response.ok) {
		throw new Error(`OpenCode Console device authorization failed (${response.status})`);
	}
	const json = (await response.json()) as Record<string, unknown>;
	const deviceCode = stringField(json, "device_code");
	const userCode = stringField(json, "user_code");
	const verification = stringField(json, "verification_uri_complete");
	const expiresIn = positiveNumber(json, "expires_in", 600);
	const interval = Math.max(1, positiveNumber(json, "interval", 5));
	if (!deviceCode || !userCode || !verification) {
		throw new Error("OpenCode Console returned an incomplete device-code response");
	}
	return {
		deviceCode,
		userCode,
		verificationUrl: resolveConsoleVerificationUrl(normalized, verification),
		expiresAt: Date.now() + expiresIn * 1000,
		intervalMs: interval * 1000,
		server: normalized,
	};
}

export async function completeDeviceSignIn(
	device: DeviceCode,
	callbacks: AuthCallbacks,
): Promise<ConsoleSession> {
	const fetcher = callbacks.fetcher ?? fetch;
	const sleep = callbacks.sleep ?? defaultSleep;
	let intervalMs = device.intervalMs;
	while (Date.now() < device.expiresAt) {
		callbacks.onProgress?.("Waiting for OpenCode Console sign-in…");
		await sleep(intervalMs, callbacks.signal);
		const response = await fetcher(`${device.server}/auth/device/token`, {
			method: "POST",
			headers: { Accept: "application/json", "Content-Type": "application/json" },
			body: JSON.stringify({
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				device_code: device.deviceCode,
				client_id: OPENCODE_CLIENT_ID,
			}),
			signal: callbacks.signal,
		});
		const value = (await response.json()) as Record<string, unknown>;
		const error = stringField(value, "error");
		if (error === "authorization_pending") continue;
		if (error === "slow_down") {
			intervalMs += 5000;
			continue;
		}
		if (error === "expired_token") {
			throw new Error("OpenCode Console device code expired; start sign-in again");
		}
		if (error === "access_denied") {
			throw new Error("OpenCode Console sign-in was denied");
		}
		if (error) throw new Error(`OpenCode Console sign-in failed: ${error}`);
		const accessToken = stringField(value, "access_token");
		const refreshToken = stringField(value, "refresh_token");
		if (!response.ok || !accessToken || !refreshToken) {
			throw new Error(`OpenCode Console token exchange failed (${response.status})`);
		}
		const [user, orgsRaw] = await Promise.all([
			getJson(fetcher, `${device.server}/api/user`, accessToken, callbacks.signal),
			getJson(fetcher, `${device.server}/api/orgs`, accessToken, callbacks.signal),
		]);
		const accountId = stringField(user, "id");
		const email = stringField(user, "email");
		if (!accountId || !email) {
			throw new Error("OpenCode Console returned incomplete account information");
		}
		const orgs = normalizeOrgs(orgsRaw);
		return {
			server: device.server,
			accessToken,
			refreshToken,
			expiresAt: Date.now() + positiveNumber(value, "expires_in", 3600) * 1000,
			accountId,
			email,
			orgs,
			...(orgs[0] ? { orgId: orgs[0].id, orgName: orgs[0].name } : {}),
		};
	}
	throw new Error("OpenCode Console device code expired; start sign-in again");
}

export async function refreshSession(
	session: ConsoleSession,
	fetcher: typeof fetch = fetch,
	signal?: AbortSignal,
): Promise<ConsoleSession> {
	const response = await fetcher(`${session.server}/auth/device/token`, {
		method: "POST",
		headers: { Accept: "application/json", "Content-Type": "application/json" },
		body: JSON.stringify({
			grant_type: "refresh_token",
			refresh_token: session.refreshToken,
			client_id: OPENCODE_CLIENT_ID,
		}),
		signal,
	});
	if (!response.ok) throw new Error(`OpenCode Console token refresh failed (${response.status})`);
	const value = (await response.json()) as Record<string, unknown>;
	const accessToken = stringField(value, "access_token");
	const newRefresh = stringField(value, "refresh_token") ?? session.refreshToken;
	if (!accessToken) throw new Error("OpenCode Console token refresh returned no access token");
	return {
		...session,
		accessToken,
		refreshToken: newRefresh,
		expiresAt: Date.now() + positiveNumber(value, "expires_in", 3600) * 1000,
	};
}

// Single-flight refresh: concurrent callers share one in-flight refresh.
let refreshPromise: Promise<ConsoleSession> | undefined;

export async function ensureFreshSession(
	session: ConsoleSession,
	force = false,
	fetcher: typeof fetch = fetch,
	signal?: AbortSignal,
): Promise<ConsoleSession> {
	const fresh = !force && session.expiresAt > Date.now() + 5 * 60_000;
	if (fresh) return session;
	if (!refreshPromise) {
		refreshPromise = refreshSession(session, fetcher, signal).finally(() => {
			refreshPromise = undefined;
		});
	}
	return refreshPromise;
}

// --- auth.json persistence (standard pi shape) ---

interface AuthJsonEntry {
	type: "oauth";
	refresh: string;
	access: string;
	expires: number;
	env?: Record<string, string>;
}

interface AuthJson {
	[providerId: string]: AuthJsonEntry | undefined;
}

async function readAuthJson(): Promise<AuthJson> {
	try {
		const raw = await readFile(authFile(), "utf8");
		const parsed = JSON.parse(raw) as unknown;
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as AuthJson;
		}
		return {};
	} catch {
		return {};
	}
}

async function writeAuthJson(auth: AuthJson): Promise<void> {
	const dir = authDir();
	await mkdir(dir, { recursive: true, mode: 0o700 });
	await writeFile(authFile(), JSON.stringify(auth, null, 2), { mode: 0o600 });
}

export async function loadSession(): Promise<ConsoleSession | undefined> {
	const auth = await readAuthJson();
	const entry = auth[PROVIDER_ID];
	if (!entry || entry.type !== "oauth") return undefined;
	const env = entry.env ?? {};
	return {
		server: env.OPENCODE_CONSOLE_SERVER ?? DEFAULT_CONSOLE_SERVER,
		accessToken: entry.access,
		refreshToken: entry.refresh,
		expiresAt: entry.expires,
		accountId: env.OPENCODE_CONSOLE_ACCOUNT_ID ?? "",
		email: env.OPENCODE_CONSOLE_EMAIL ?? "",
		orgs: [],
		...(env.OPENCODE_CONSOLE_ORG_ID ? { orgId: env.OPENCODE_CONSOLE_ORG_ID } : {}),
		...(env.OPENCODE_CONSOLE_ORG_NAME ? { orgName: env.OPENCODE_CONSOLE_ORG_NAME } : {}),
	};
}

/**
 * Build the canonical `env` block that lives next to the OAuth refresh/access
 * fields in `auth.json`. The runtime persists this verbatim as part of the
 * OAuth credential so `refreshModels` can recover the org id, server URL,
 * and account info after a restart.
 */
export function envForSession(
	session: ConsoleSession,
	fetchedOrgs?: ConsoleOrg[],
): Record<string, string> {
	const env: Record<string, string> = {
		OPENCODE_CONSOLE_SERVER: session.server,
		OPENCODE_CONSOLE_ACCOUNT_ID: session.accountId,
		OPENCODE_CONSOLE_EMAIL: session.email,
	};
	if (session.orgId) env.OPENCODE_CONSOLE_ORG_ID = session.orgId;
	if (session.orgName) env.OPENCODE_CONSOLE_ORG_NAME = session.orgName;
	if (fetchedOrgs && fetchedOrgs.length) {
		env.OPENCODE_CONSOLE_ORG_COUNT = String(fetchedOrgs.length);
	}
	return env;
}

export async function saveSession(
	session: ConsoleSession,
	fetchedOrgs?: ConsoleOrg[],
): Promise<void> {
	const auth = await readAuthJson();
	auth[PROVIDER_ID] = {
		type: "oauth",
		refresh: session.refreshToken,
		access: session.accessToken,
		expires: session.expiresAt,
		env: envForSession(session, fetchedOrgs),
	};
	await writeAuthJson(auth);
}

export async function deleteSession(): Promise<void> {
	const auth = await readAuthJson();
	delete auth[PROVIDER_ID];
	await writeAuthJson(auth);
}

export async function listSessionOrgs(fetcher: typeof fetch = fetch, session: ConsoleSession): Promise<ConsoleOrg[]> {
	const response = await fetcher(`${session.server}/api/orgs`, {
		headers: { Accept: "application/json", Authorization: `Bearer ${session.accessToken}` },
	});
	if (!response.ok) throw new Error(`OpenCode Console /api/orgs failed (${response.status})`);
	return normalizeOrgs(await response.json());
}
