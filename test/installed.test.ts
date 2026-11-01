import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

/**
 * Packed-extension smoke test: pack the published tarball, load it into the
 * bundled pi CLI from the devDependency, and stream one prompt through the
 * OpenCode Go provider. Everything is isolated (HOME, XDG dirs, agent dir),
 * pi runs `--offline`, and `test/fixtures/host-fetch.ts` replaces `fetch`,
 * so no request can leave the machine and no real credential is involved.
 *
 * The model is passed explicitly with `--model` so the case does not depend
 * on startup default-model resolution. Once the registration-time catalog
 * seed (PR #30) lands, a second case without `--model` (relying on
 * `defaultProvider`/`defaultModel` in settings.json) can pin that the saved
 * default is honoured at startup.
 */

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const GO_PROVIDER_ID = "opencode-go-console";
const MODEL_ID = "deepseek-v4.1-flash";
const ORG_ID = "org_smoke";

// Shape of a row as the extension publishes it to pi's models-store.json.
const persistedRow = {
	id: MODEL_ID,
	name: "DeepSeek V4.1 Flash",
	api: "openai-completions",
	baseUrl: "https://opencode.ai/inference/go/openai/v1",
	contextWindow: 1_000_000,
	maxTokens: 32_000,
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	wireId: MODEL_ID,
	wireApi: "openai-completions",
};

// Fake device-code session, far from expiry so no token refresh is attempted.
const oauthEntry = {
	type: "oauth",
	refresh: "smoke-refresh-token",
	access: "smoke-access-token",
	expires: Date.now() + 365 * 24 * 60 * 60 * 1000,
	env: {
		OPENCODE_CONSOLE_SERVER: "https://opencode.ai/console",
		OPENCODE_CONSOLE_ACCOUNT_ID: "acc_smoke",
		OPENCODE_CONSOLE_EMAIL: "smoke@example.invalid",
		OPENCODE_CONSOLE_ORG_ID: ORG_ID,
		OPENCODE_CONSOLE_ORG_NAME: "Smoke",
	},
};

interface RunResult {
	status: number | null;
	stdout: string;
	stderr: string;
}

/** Async spawn so the test runner's own timeout stays in control. */
function run(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }): Promise<RunResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
		child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
		const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs);
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (status) => {
			clearTimeout(timer);
			resolve({ status, stdout, stderr });
		});
	});
}

test("packed extension streams an OpenCode Go prompt through bundled pi", { timeout: 90_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-provider-opencode-console-packed-"));
	const repository = fileURLToPath(new URL("..", import.meta.url));
	const cli = fileURLToPath(new URL("./bundle/cli.js", import.meta.resolve("@earendil-works/pi-coding-agent")));
	try {
		execFileSync(npm, ["pack", "--ignore-scripts", "--pack-destination", root], {
			cwd: repository,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		const archives = (await readdir(root)).filter((name) => name.endsWith(".tgz"));
		assert.equal(archives.length, 1);
		execFileSync("tar", ["-xzf", join(root, archives[0]!), "-C", root]);
		const fixture = join(root, "host-fetch.ts");
		await copyFile(new URL("./fixtures/host-fetch.ts", import.meta.url), fixture);

		const agent = join(root, "agent");
		await mkdir(agent);
		await writeFile(join(agent, "settings.json"), JSON.stringify({ quietStartup: true, checkForUpdates: false }));
		await writeFile(join(agent, "auth.json"), JSON.stringify({ [GO_PROVIDER_ID]: oauthEntry }), { mode: 0o600 });
		await writeFile(
			join(agent, "models-store.json"),
			JSON.stringify({ [GO_PROVIDER_ID]: { models: [persistedRow], checkedAt: Date.now() } }),
		);
		const log = join(root, "fetch.log");
		await writeFile(log, "");

		const child = await run(
			process.execPath,
			[
				cli,
				"--offline",
				"--no-extensions",
				"-e", fixture,
				"-e", join(root, "package"),
				"--no-mcp", "--no-skills", "--no-context-files", "--no-prompt-templates", "--no-themes",
				"--no-approve", "--no-session", "--no-tools",
				"--model", `${GO_PROVIDER_ID}/${MODEL_ID}`,
				"--mode", "json",
				"-p", "Reply with OK.",
			],
			{
				cwd: root,
				timeoutMs: 60_000,
				env: {
					PATH: process.env.PATH,
					HOME: root,
					TERM: "xterm-256color",
					PI_CODING_AGENT_DIR: agent,
					PI_TELEMETRY: "0",
					PI_OFFLINE: "1",
					XDG_CONFIG_HOME: root,
					XDG_DATA_HOME: root,
					XDG_STATE_HOME: root,
					XDG_CACHE_HOME: root,
					OPENCODE_TEST_FETCH_LOG: log,
				},
			},
		);
		const output = child.stdout + child.stderr;
		const fetchLog = await readFile(log, "utf8");
		const diagnostics = `exit=${child.status}\nfetch log:\n${fetchLog}\nstderr:\n${child.stderr.slice(-4000)}`;
		assert.equal(child.status, 0, `bundled pi failed\n${diagnostics}`);
		assert.ok(
			!/Cannot find module|failed to load|extension error/i.test(output),
			`packed extension failed to load\n${diagnostics}`,
		);
		const events = child.stdout.split("\n").flatMap((line) => {
			try {
				return [JSON.parse(line) as { type?: string; message?: Record<string, unknown> }];
			} catch {
				return [];
			}
		});
		const reply = events.find((event) => event.type === "message_end" && event.message?.role === "assistant");
		assert.ok(reply, `no assistant message_end event\n${diagnostics}`);
		assert.equal(reply.message?.provider, GO_PROVIDER_ID, diagnostics);
		assert.equal(reply.message?.model, MODEL_ID, diagnostics);
		assert.equal(reply.message?.stopReason, "stop", diagnostics);
		const content = reply.message?.content as Array<{ type: string; text?: string }> | undefined;
		assert.ok(
			content?.some((part) => part.type === "text" && part.text === "PACKED_OPENCODE_OK"),
			`synthetic streamed response was not delivered\n${diagnostics}`,
		);
		// Exactly one request, to the Go inference route, carrying the session's
		// bearer token, org header, and routing session id; nothing else.
		assert.equal(fetchLog, `inference model=${MODEL_ID} auth=true org=${ORG_ID} session=true\n`);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
