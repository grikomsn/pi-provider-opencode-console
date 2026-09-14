/**
 * Registers the `/opencode-console` command for managing the OpenCode
 * Console session: status, refresh, switch org, logout.
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	deleteSession,
	ensureFreshSession,
	isPublicConsoleServer,
	loadSession,
	listSessionOrgs,
	saveSession,
} from "./auth.ts";
import { buildPiModels, loadConsoleConfig } from "./models.ts";
import type { ConsoleSession } from "./auth.ts";

const SUBCOMMANDS = {
	status: "status",
	refresh: "refresh",
	models: "models",
	switch: "switch-org",
	switchOrg: "switch-org",
	logout: "logout",
	signout: "logout",
};

export function registerCommand(pi: ExtensionAPI): void {
	pi.registerCommand("opencode-console", {
		description: "Manage OpenCode Console: status, refresh, switch-org, logout",
		async handler(args, ctx) {
			const subcommandRaw = args.trim().split(/\s+/)[0] ?? "";
			const subcommand = SUBCOMMANDS[subcommandRaw as keyof typeof SUBCOMMANDS] ?? "status";

			const session = await loadSession();
			if (!session) {
				ctx.ui.notify("Not signed in to OpenCode Console. Run /login opencode-console.", "warning");
				return;
			}

			if (subcommand === "logout") {
				await deleteSession();
				ctx.ui.notify("Signed out of OpenCode Console.", "info");
				return;
			}

			if (subcommand === "switch-org") {
				await switchOrg(ctx, session);
				return;
			}

			if (subcommand === "refresh" || subcommand === "models") {
				await refreshModels(ctx, session);
				return;
			}

			// Default: status
			await showStatus(ctx, session);
		},
	});
}

async function switchOrg(ctx: ExtensionCommandContext, session: ConsoleSession): Promise<void> {
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

async function refreshModels(ctx: ExtensionCommandContext, session: ConsoleSession): Promise<void> {
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

async function showStatus(ctx: ExtensionCommandContext, session: ConsoleSession): Promise<void> {
	const expiresIn = Math.max(0, Math.round((session.expiresAt - Date.now()) / 1000));
	const expiresInMin = Math.round(expiresIn / 60);
	const serverLabel = isPublicConsoleServer(session.server)
		? session.server
		: `${session.server} (custom)`;
	const lines = [
		"OpenCode Console status",
		`  Server: ${serverLabel}`,
		`  Account: ${session.email || session.accountId || "(unknown)"}`,
		`  Org: ${session.orgName ?? "(none — run /opencode-console switch-org)"}`,
		`  Token expires in: ${expiresInMin}m`,
	];
	ctx.ui.notify(lines.join("\n"), "info");
}
