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
import { OPENCODE_ORIGIN } from "./endpoint.ts";

// Public Console is served at https://opencode.ai/console. The console.opencode.ai
// alias 302-prefixes /console, so using it as a browser origin doubles that path.
export const DEFAULT_CONSOLE_SERVER = `${OPENCODE_ORIGIN}/console`;
export const CONSOLE_ALIAS_HOST = "console.opencode.ai";
export const OPENCODE_CLIENT_ID = "opencode-cli";
export const OPENCODE_CLIENT = "pi-provider-opencode-console";
export const PROVIDER_ID = "opencode-console";
/**
 * Go-mode provider id — sibling of `opencode-console` for OpenCode's Go
 * (subscription) auth system. Deliberately distinct from pi's built-in
 * `opencode-go` so the built-in static catalog/credential stays untouched.
 */
export const GO_PROVIDER_ID = "opencode-go-console";

/**
 * Match pi's configured agent directory, including isolated environments.
 * Resolve lazily so changes made before a session load are respected.
 */
function authDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
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
	/** Organization bound by the server's device grant when sign-in requested org scope. */
	scopedOrgId?: string;
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
		// Opt in to organization scoping: the Console browser authorization page
		// binds the grant to the organization chosen during approval, returned
		// as org_id at token exchange. Servers that ignore the flag behave as
		// before (sister parity: opencode-copilot-chat #66, tanstack adapter).
		body: JSON.stringify({ client_id: OPENCODE_CLIENT_ID, supports_org_scope: true }),
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
		// A server-scoped grant (org_id at token exchange) pins the session to
		// the organization chosen during browser authorization. Un-scoped
		// single-org accounts self-select; multi-org accounts pick explicitly
		// (the login flow prompts when orgId is unset) — no silent first-org pin.
		const grantedOrgId = stringField(value, "org_id");
		const scopedOrg = grantedOrgId ? orgs.find((o) => o.id === grantedOrgId) : undefined;
		if (grantedOrgId && !scopedOrg) {
			throw new Error("OpenCode Console granted a session for an unavailable organization");
		}
		const selected = scopedOrg ?? (orgs.length === 1 ? orgs[0] : undefined);
		return {
			server: device.server,
			accessToken,
			refreshToken,
			expiresAt: Date.now() + positiveNumber(value, "expires_in", 3600) * 1000,
			accountId,
			email,
			orgs,
			...(selected ? { orgId: selected.id, orgName: selected.name } : {}),
			...(scopedOrg ? { scopedOrgId: scopedOrg.id } : {}),
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
	// Honor organization scoping across refreshes (sister parity): a scoped
	// session keeps its org — a server response that changes it is a hard
	// error; an omitted org_id keeps the current one; a fresh org_id on an
	// un-scoped session is adopted.
	const refreshedOrgId = stringField(value, "org_id");
	if (session.scopedOrgId && refreshedOrgId && refreshedOrgId !== session.scopedOrgId) {
		throw new Error("OpenCode Console refresh changed the session's organization scope; sign in again");
	}
	const refreshedOrg = refreshedOrgId ? session.orgs.find((o) => o.id === refreshedOrgId) : undefined;
	return {
		...session,
		accessToken,
		refreshToken: newRefresh,
		expiresAt: Date.now() + positiveNumber(value, "expires_in", 3600) * 1000,
		...(refreshedOrg ? { orgId: refreshedOrg.id, orgName: refreshedOrg.name } : {}),
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

/** OAuth credential entries, as persisted by pi's runtime (plus our `env` block). */
interface OAuthJsonEntry {
	type: "oauth";
	refresh: string;
	access: string;
	expires: number;
	env?: Record<string, string>;
}

type AuthJsonEntry = OAuthJsonEntry;

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

/** Rebuild a ConsoleSession from a persisted oauth entry (env block + tokens). */
function sessionFromEntry(entry: OAuthJsonEntry): ConsoleSession | undefined {
	const env = entry.env ?? {};
	let orgs: ConsoleOrg[] = [];
	const rawOrgs = env.OPENCODE_CONSOLE_ORGS;
	if (rawOrgs) {
		try {
			orgs = normalizeOrgs(JSON.parse(rawOrgs));
		} catch {
			orgs = [];
		}
	}
	return {
		server: env.OPENCODE_CONSOLE_SERVER ?? DEFAULT_CONSOLE_SERVER,
		accessToken: entry.access,
		refreshToken: entry.refresh,
		expiresAt: entry.expires,
		accountId: env.OPENCODE_CONSOLE_ACCOUNT_ID ?? "",
		email: env.OPENCODE_CONSOLE_EMAIL ?? "",
		orgs,
		...(env.OPENCODE_CONSOLE_ORG_ID ? { orgId: env.OPENCODE_CONSOLE_ORG_ID } : {}),
		...(env.OPENCODE_CONSOLE_ORG_NAME ? { orgName: env.OPENCODE_CONSOLE_ORG_NAME } : {}),
		...(env.OPENCODE_CONSOLE_SCOPED_ORG_ID ? { scopedOrgId: env.OPENCODE_CONSOLE_SCOPED_ORG_ID } : {}),
	};
}

export async function loadSession(providerId: string = PROVIDER_ID): Promise<ConsoleSession | undefined> {
	return (await loadCredential(providerId) as OAuthStoredCredential | undefined)?.session;
}

/** Device-flow session rebuilt from a stored `oauth` entry. */
export interface OAuthStoredCredential {
	kind: "oauth";
	session: ConsoleSession;
}
export type StoredCredential = OAuthStoredCredential;

/**
 * Read the provider's auth.json entry (direct file access so commands and
 * stream wrappers share one view of the stored credential). Only
 * device-code sessions (`type: "oauth"`) are supported — legacy
 * `{ type: "api_key" }` entries are ignored (the provider registers no
 * API-key method, so pi's runtime refuses to resolve them).
 */
export async function loadCredential(providerId: string = PROVIDER_ID): Promise<StoredCredential | undefined> {
	const auth = await readAuthJson();
	const entry = auth[providerId];
	if (!entry) return undefined;
	if (entry.type === "oauth") {
		const session = sessionFromEntry(entry);
		return session ? { kind: "oauth", session } : undefined;
	}
	return undefined;
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
	if (session.scopedOrgId) env.OPENCODE_CONSOLE_SCOPED_ORG_ID = session.scopedOrgId;
	// Persist the org list so `/opencode-console switch-org` survives a
	// restart; `fetchedOrgs` (freshly fetched) takes precedence over the
	// session's carried-over list.
	const orgs = fetchedOrgs && fetchedOrgs.length ? fetchedOrgs : session.orgs;
	if (orgs.length) env.OPENCODE_CONSOLE_ORGS = JSON.stringify(orgs);
	return env;
}

export async function saveSession(
	session: ConsoleSession,
	fetchedOrgs?: ConsoleOrg[],
	providerId: string = PROVIDER_ID,
): Promise<void> {
	const auth = await readAuthJson();
	auth[providerId] = {
		type: "oauth",
		refresh: session.refreshToken,
		access: session.accessToken,
		expires: session.expiresAt,
		env: envForSession(session, fetchedOrgs),
	};
	await writeAuthJson(auth);
}

export async function deleteSession(providerId: string = PROVIDER_ID): Promise<void> {
	const auth = await readAuthJson();
	delete auth[providerId];
	await writeAuthJson(auth);
}

/**
 * Copy the shared Console device-flow session's rotated token fields into
 * the sibling provider's oauth entry (when present and oauth-typed) after a
 * canonical refresh, so refresh-token rotation keeps both provider entries
 * valid. Only the token fields are mirrored: each entry keeps its own `env`,
 * so a per-provider organization choice survives a sibling's refresh.
 * Entries of any other shape and missing entries are left untouched.
 */
export async function mirrorOAuthTokens(
	session: ConsoleSession,
	from: string,
	to: string,
): Promise<void> {
	if (from === to) return;
	const auth = await readAuthJson();
	const target = auth[to];
	if (!target || target.type !== "oauth") return;
	auth[to] = {
		...target,
		type: "oauth",
		refresh: session.refreshToken,
		access: session.accessToken,
		expires: session.expiresAt,
	};
	await writeAuthJson(auth);
}

export async function listSessionOrgs(fetcher: typeof fetch = fetch, session: ConsoleSession): Promise<ConsoleOrg[]> {
	const response = await fetcher(`${session.server}/api/orgs`, {
		headers: { Accept: "application/json", Authorization: `Bearer ${session.accessToken}` },
	});
	if (!response.ok) throw new Error(`OpenCode Console /api/orgs failed (${response.status})`);
	return normalizeOrgs(await response.json());
}
