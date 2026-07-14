/**
 * omp-patch / transient-stream-retry
 *
 * Continues the main session after transient provider failures that stock
 * auto-retry sometimes fail-fasts on:
 *
 * - Cursor Connect `resource_exhausted` (misclassified as 30m quota → maxDelayMs fail-fast)
 * - Stream idle stall: "...stream stalled while waiting for the next event"
 * - First-event timeout: "...timed out while waiting for the first event"
 * - Thinking-loop stalls that advertise themselves as "stream stall"
 *
 * Extension APIs cannot rewrite parseRateLimitReason or the idle watchdog.
 * This only recovers after session_stop when the last assistant message is an
 * error matching the patterns above.
 *
 * Backoff: ~5s first continue, then ~45–75s. Cap: 3 consecutive continues.
 *
 * Note: providers.streamIdleTimeoutSeconds / streamFirstEventTimeoutSeconds
 * must be > 0 for stall/first-event timeouts to fire (0 disables the watchdog).
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const MAX_CONTINUATIONS = 3;
const FIRST_DELAY_MS = 5_000;
const CAPACITY_BASE_MS = 45_000;
const CAPACITY_JITTER_MS = 30_000;

/** Failures worth a short continue rather than leaving the session idle. */
const TRANSIENT_FAILURE_RE =
	/resource[\s_]?exhausted|exceeds retry\.maxDelayMs|stream stalled|timed out while waiting for the first event|stream stall/i;

function capacityDelayMs(attempt: number): number {
	if (attempt <= 1) return FIRST_DELAY_MS;
	return CAPACITY_BASE_MS + Math.random() * CAPACITY_JITTER_MS;
}

function errorText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const m = message as { errorMessage?: string };
	return m.errorMessage ?? "";
}

function isTransientStreamFailure(message: unknown): boolean {
	if (!message || typeof message !== "object") return false;
	const m = message as { role?: string; stopReason?: string; errorMessage?: string };
	if (m.role !== "assistant" || m.stopReason !== "error") return false;
	return TRANSIENT_FAILURE_RE.test(m.errorMessage ?? "");
}

function continueHint(err: string): string {
	if (/resource[\s_]?exhausted|exceeds retry\.maxDelayMs/i.test(err)) {
		return "The previous turn failed on a transient Cursor/Connect resource_exhausted (model capacity) error. Continue the interrupted work from where you left off; do not ask the user to restate the request.";
	}
	if (/stalled|first event|stream stall/i.test(err)) {
		return "The previous turn failed because the provider stream stalled or timed out waiting for events. Continue the interrupted work from where you left off; do not ask the user to restate the request.";
	}
	return "The previous turn failed on a transient provider/stream error. Continue the interrupted work from where you left off; do not ask the user to restate the request.";
}

export default function transientStreamRetry(pi: ExtensionAPI): void {
	pi.setLabel("omp-patch");

	let consecutive = 0;
	let inFlight = false;

	pi.on("turn_end", async event => {
		const last = event.message;
		if (last?.role === "assistant" && last.stopReason !== "error") {
			consecutive = 0;
		}
	});

	pi.on("auto_retry_end", async (event, ctx) => {
		if (event.success) {
			consecutive = 0;
			return;
		}
		const err = event.finalError ?? "";
		if (!TRANSIENT_FAILURE_RE.test(err)) return;
		if (ctx.hasUI) {
			ctx.ui.notify(
				`Transient stream/provider fail-fast (attempt ${event.attempt}); will try session continue if idle`,
				"warning",
			);
		}
	});

	pi.on("session_stop", async (event, ctx: ExtensionContext) => {
		if (inFlight) return;
		if (!isTransientStreamFailure(event.last_assistant_message)) {
			consecutive = 0;
			return;
		}

		if (consecutive >= MAX_CONTINUATIONS) {
			if (ctx.hasUI) {
				ctx.ui.notify(`omp-patch: gave up after ${MAX_CONTINUATIONS} continues`, "error");
			}
			consecutive = 0;
			return;
		}

		consecutive += 1;
		const delayMs = Math.round(capacityDelayMs(consecutive));
		const err = errorText(event.last_assistant_message) || "transient stream error";

		if (ctx.hasUI) {
			ctx.ui.notify(
				`omp-patch: ${err.slice(0, 80)} — retrying in ${Math.round(delayMs / 1000)}s (${consecutive}/${MAX_CONTINUATIONS})`,
				"warning",
			);
		}

		inFlight = true;
		try {
			await Bun.sleep(delayMs);
			return {
				continue: true,
				additionalContext: continueHint(err),
			};
		} finally {
			inFlight = false;
		}
	});
}
