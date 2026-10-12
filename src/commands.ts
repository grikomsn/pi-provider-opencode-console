/**
 * Registers the `/opencode-console` and `/opencode-go-console` commands for
 * managing the OpenCode providers: status, refresh, switch org (Console
 * only), logout. Operates on the stored device-code OAuth session
 * (`type: "oauth"` auth.json entries) — API-key (service key) auth is no
 * longer supported.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	deleteSession,
	ensureFreshSession,
	isPublicConsoleServer,
	loadCredential,
	listSessionOrgs,
	saveSession,
} from "./auth.ts";
import type { ConsoleSession } from "./auth.ts";
import { buildPiModels, loadConsoleConfig, loadPublicModels } from "./models.ts";
import type { OpenCodeMode } from "./endpoint.ts";

const SUBCOMMANDS = {
	status: "status",
	refresh: "refresh",
	models: "models",
	switch: "switch-org",
	switchOrg: "switch-org",
	"switch-org": "switch-org",
	logout: "logout",
	signout: "logout",
};

interface ManageOptions {
	providerId: string;
	displayName: string;
	loginHint: string;
	/** Console: org selection + org-scoped catalog are session features. */
	allowSwitchOrg: boolean;
	/** Gateway mode for the public /models catalog. */
	catalogMode: OpenCodeMode;
}

export function registerCommand(pi: ExtensionAPI): void {
	registerManageCommand(pi, {
		providerId: "opencode-console",
		displayName: "OpenCode Console",
		loginHint: "/login opencode-console",
		allowSwitchOrg: true,
		catalogMode: "console",
	});
	registerManageCommand(pi, {
		providerId: "opencode-go-console",
		displayName: "OpenCode Go",
		loginHint: "/login opencode-go-console",
		allowSwitchOrg: false,
		catalogMode: "go",
	});
}

function registerManageCommand(pi: ExtensionAPI, opts: ManageOptions): void {
	pi.registerCommand(opts.providerId, {
		description: `Manage ${opts.displayName}: status, refresh${opts.allowSwitchOrg ? ", switch-org" : ""}, logout`,
		async handler(args, ctx) {
			const subcommandRaw = args.trim().split(/\s+/)[0] ?? "";
			const subcommand = SUBCOMMANDS[subcommandRaw as keyof typeof SUBCOMMANDS] ?? "status";

			const cred = await loadCredential(opts.providerId);
			if (!cred) {
				ctx.ui.notify(`Not signed in to ${opts.displayName}. Run ${opts.loginHint}.`, "warning");
				return;
			}

			if (subcommand === "logout") {
				await deleteSession(opts.providerId);
				ctx.ui.notify(
					opts.allowSwitchOrg
						? `Signed out of ${opts.displayName}.`
						: `Signed out of ${opts.displayName}. The shared Console device session (if stored under opencode-console) is preserved.`,
					"info",
				);
				return;
			}

			if (subcommand === "switch-org") {
				if (opts.allowSwitchOrg) {
					await switchOrg(ctx, cred.session);
				} else {
					ctx.ui.notify(
						`switch-org is not available for ${opts.displayName}; the organization is chosen at sign-in.`,
						"warning",
					);
				}
				return;
			}

			if (subcommand === "refresh" || subcommand === "models") {
				if (opts.allowSwitchOrg) {
					await refreshOrgModels(ctx, cred.session);
				} else {
					// Go discovery is always the public /models catalog.
					try {
						const fresh = await ensureFreshSession(cred.session);
						await refreshPublicModels(ctx, opts, fresh.orgId ? fresh.accessToken : undefined);
					} catch (err) {
						ctx.ui.notify(
							`Refresh failed: ${err instanceof Error ? err.message : String(err)}`,
							"error",
						);
					}
				}
				return;
			}

			// Default: status
			await showStatus(ctx, opts, cred.session);
		},
	});
}

async function refreshPublicModels(
	ctx: ExtensionCommandContext,
	opts: ManageOptions,
	token: string | undefined,
): Promise<void> {
	try {
		const providers = await loadPublicModels(opts.catalogMode, token);
		const models = buildPiModels(providers);
		ctx.ui.notify(
			`Found ${models.length} models via the public ${opts.displayName} catalog. Run /reload to refresh the picker.`,
			"info",
		);
	} catch (err) {
		ctx.ui.notify(
			`Refresh failed: ${err instanceof Error ? err.message : String(err)}`,
			"error",
		);
	}
}

async function switchOrg(ctx: ExtensionCommandContext, session: ConsoleSession): Promise<void> {
	if (session.scopedOrgId) {
		ctx.ui.notify(
			"This Console session is scoped to the organization chosen at sign-in; sign in again to switch.",
			"warning",
		);
		return;
	}
	try {
		const fresh = await ensureFreshSession(session);
		const orgs = await listSessionOrgs(fetch, fresh);
		if (!orgs.length) {
			ctx.ui.notify("No organizations available for this account.", "warning");
			return;
		}
		const labels = orgs.map((o) => `${o.name} (${o.id})`);
		const picked = await ctx.ui.select("Select organization", labels);
		if (!picked) return;
		const idx = labels.indexOf(picked);
		if (idx < 0) return;
		const org = orgs[idx]!;
		await saveSession({ ...fresh, orgs, orgId: org.id, orgName: org.name });
		ctx.ui.notify(`Switched to ${org.name}. Run /reload to refresh models.`, "info");
	} catch (err) {
		ctx.ui.notify(
			`Switch org failed: ${err instanceof Error ? err.message : String(err)}`,
			"error",
		);
	}
}

async function refreshOrgModels(ctx: ExtensionCommandContext, session: ConsoleSession): Promise<void> {
	try {
		const fresh = await ensureFreshSession(session);
		if (!fresh.orgId) {
			ctx.ui.notify("No organization selected. Run /opencode-console switch-org.", "warning");
			return;
		}
		const providers = await loadConsoleConfig(fresh.server, fresh.accessToken, fresh.orgId);
		const models = buildPiModels(providers);
		ctx.ui.notify(
			`Found ${models.length} models for ${fresh.orgName ?? fresh.orgId}. Run /reload to refresh the picker.`,
			"info",
		);
	} catch (err) {
		ctx.ui.notify(
			`Refresh failed: ${err instanceof Error ? err.message : String(err)}`,
			"error",
		);
	}
}

async function showStatus(
	ctx: ExtensionCommandContext,
	opts: ManageOptions,
	session: ConsoleSession,
): Promise<void> {
	const expiresIn = Math.max(0, Math.round((session.expiresAt - Date.now()) / 1000));
	const expiresInMin = Math.round(expiresIn / 60);
	const serverLabel = isPublicConsoleServer(session.server)
		? session.server
		: `${session.server} (custom)`;
	const orgLabel = session.orgName
		?? (opts.allowSwitchOrg ? "(none — run /opencode-console switch-org)" : "(none)");
	const lines = [
		`${opts.displayName} status`,
		"  Auth: device-code (OAuth) session",
		`  Server: ${serverLabel}`,
		`  Account: ${session.email || session.accountId || "(unknown)"}`,
		`  Org: ${orgLabel}${session.scopedOrgId ? " (server-scoped at sign-in)" : ""}`,
		`  Token expires in: ${expiresInMin}m`,
	];
	ctx.ui.notify(lines.join("\n"), "info");
}
