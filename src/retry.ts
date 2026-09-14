/**
 * Retry classification helpers shared by the stream wrapper.
 *
 * Mirrors the sibling VSCode bridge (`opencode-copilot-chat`,
 * `src/provider/retry.ts`): retry transient network faults and retryable
 * server statuses with exponential backoff, and patch 400 responses by
 * dropping the request option the server rejected.
 *
 * Because streaming is delegated to pi-ai's built-in APIs, statuses are
 * recovered from the formatted error message rather than from a response
 * object. pi-ai composes messages like `"<prefix> (502): <body>"` or
 * `"403 status code (no body)"` (see `pi-ai/utils/error-body.js`).
 */

export type PatchableOption = "temperature" | "reasoning" | "thinkingBudgets";

/** Extract an HTTP status (400-599) from a formatted provider error message. */
export function statusFromErrorMessage(message: string): number | undefined {
	const paren = /\((\d{3})\)/.exec(message);
	const status = paren
		? Number(paren[1])
		: Number(/\b(\d{3}) status code\b/.exec(message)?.[1] ?? /^\s*(\d{3})\b/.exec(message.trim())?.[1]);
	if (!Number.isInteger(status) || status < 400 || status > 599) return undefined;
	return status;
}

export function isTransientServerError(status: number, detail: string): boolean {
	return (
		status === 502 ||
		status === 503 ||
		status === 504 ||
		(status === 500 && /Router[._-]?Unavailable/i.test(detail))
	);
}

const NETWORK_PATTERN =
	/fetch failed|ECONNRESET|ECONNREFUSED|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET|socket hang up|terminated/i;

export function isTransientNetworkError(error: unknown): boolean {
	if (!(error instanceof Error) || error.name === "AbortError") return false;
	const detail = `${error.name}: ${error.message} ${networkCause(error)}`;
	return NETWORK_PATTERN.test(detail);
}

function networkCause(error: Error): string {
	const cause = (error as Error & { cause?: unknown }).cause;
	if (cause instanceof Error) return `${cause.name}: ${cause.message} ${networkCause(cause)}`;
	return typeof cause === "string" ? cause : "";
}

/** Exponential backoff capped at 2s: 250, 500, 1000, 2000… */
export function retryDelayMs(attempt: number): number {
	return Math.min(2_000, 250 * 2 ** Math.max(0, attempt));
}

/**
 * Map a 400 response to the stream option that should be dropped on retry,
 * following the sibling's rejected-field patterns but keyed to
 * `SimpleStreamOptions` fields instead of raw request body keys.
 */
export function patchableOptionFrom400(message: string): PatchableOption | undefined {
	const rejected: Array<[RegExp, PatchableOption]> = [
		[/\btemperature\b/i, "temperature"],
		[/\b(?:enable_thinking|thinking(?:_budget)?|reasoning(?:_effort)?)\b/i, "reasoning"],
		[/\bbudget_tokens\b|\bthinking_budgets\b/i, "thinkingBudgets"],
	];
	for (const [field, option] of rejected) {
		const hit = new RegExp(
			`(?:invalid|unsupported|extra inputs[^\\n]*permitted)[^\\n]*${field.source}|${field.source}[^\\n]*(?:invalid|unsupported|only accepts)`,
			"i",
		);
		if (hit.test(message)) return option;
	}
	return undefined;
}