import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Run `fn` with `PI_CODING_AGENT_DIR` pointed at a throwaway agent directory
 * holding `models-store.json` (or nothing, when `store` is omitted) so the
 * registration-time catalog seed never reads the developer's real store.
 *
 * When `store` is a string it is written verbatim (for malformed-JSON cases);
 * anything else is serialised.
 */
export async function withAgentDir(
	store: unknown,
	fn: () => Promise<void> | void,
): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "pi-provider-opencode-console-agent-"));
	const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		if (store !== undefined) {
			await writeFile(
				join(dir, "models-store.json"),
				typeof store === "string" ? store : JSON.stringify(store),
			);
		}
		await fn();
	} finally {
		if (prevAgentDir === undefined) {
			delete process.env.PI_CODING_AGENT_DIR;
		} else {
			process.env.PI_CODING_AGENT_DIR = prevAgentDir;
		}
		await rm(dir, { recursive: true, force: true });
	}
}
