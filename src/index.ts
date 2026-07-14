/**
 * omp-patch / transient-stream-retry
 *
 * Continues the main session after transient provider failures that stock
 * auto-retry sometimes fail-fasts on:
 *
 * - Cursor Connect `resource_exhausted` (misclassified as 30m quota → maxDelayMs fail-fast)
 * - Stream idle stall / first-event timeout / thinking-loop "stream stall"
 *
 * Important: omp skips `session_stop` when the failed assistant message still
 * contains toolCall blocks (common for Cursor mid-turn resource_exhausted).
 * This extension therefore recovers primarily from `agent_end`, with
 * `session_stop` kept as a fallback for text-only error settles.
 *
 * Backoff: ~5s first continue, then ~45–75s. Cap: 3 consecutive continues.
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const MAX_CONTINUATIONS = 3;
const FIRST_DELAY_MS = 5_000;
const CAPACITY_BASE_MS = 45_000;
const CAPACITY_JITTER_MS = 30_000;

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

function lastAssistant(messages: unknown[] | undefined): unknown {
	if (!Array.isArray(messages)) return undefined;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string } | undefined;
		if (m?.role === "assistant") return m;
	}
	return undefined;
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
	/** Prevent agent_end + session_stop from both scheduling a continue. */
	let handledErrorKey: string | undefined;

	const scheduleContinue = async (
		message: unknown,
		ctx: ExtensionContext,
		via: "agent_end" | "session_stop",
	): Promise<{ continue: true; additionalContext: string } | undefined> => {
		if (inFlight) return;
		if (!isTransientStreamFailure(message)) {
			consecutive = 0;
			handledErrorKey = undefined;
			return;
		}

		const err = errorText(message) || "transient stream error";
		const stamp = String((message as { timestamp?: number }).timestamp ?? "");
		const dedupeKey = `${err}:${stamp}`;
		if (handledErrorKey === dedupeKey) return;

		if (consecutive >= MAX_CONTINUATIONS) {
			if (ctx.hasUI) {
				ctx.ui.notify(`omp-patch: gave up after ${MAX_CONTINUATIONS} continues`, "error");
			}
			consecutive = 0;
			return;
		}

		consecutive += 1;
		handledErrorKey = dedupeKey;
		const delayMs = Math.round(capacityDelayMs(consecutive));

		if (ctx.hasUI) {
			ctx.ui.notify(
				`omp-patch (${via}): ${err.slice(0, 70)} — retrying in ${Math.round(delayMs / 1000)}s (${consecutive}/${MAX_CONTINUATIONS})`,
				"warning",
			);
		}

		inFlight = true;
		try {
			await Bun.sleep(delayMs);
			const additionalContext = continueHint(err);

			if (via === "session_stop") {
				return { continue: true, additionalContext };
			}

			// agent_end path: session_stop is often skipped when the failed
			// assistant message still has toolCall blocks. Kick a turn ourselves.
			pi.sendMessage(
				{
					customType: "omp-patch-retry",
					content: additionalContext,
					display: true,
				},
				{ triggerTurn: true, deliverAs: "nextTurn" },
			);
		} finally {
			inFlight = false;
		}
	};

	pi.on("turn_end", async event => {
		const last = event.message;
		if (last?.role === "assistant" && last.stopReason !== "error") {
			consecutive = 0;
			handledErrorKey = undefined;
		}
	});

	pi.on("auto_retry_end", async (event, ctx) => {
		if (event.success) {
			consecutive = 0;
			handledErrorKey = undefined;
			return;
		}
		const err = event.finalError ?? "";
		if (!TRANSIENT_FAILURE_RE.test(err)) return;
		if (ctx.hasUI) {
			ctx.ui.notify(
				`omp-patch: fail-fast (${event.attempt}); waiting for agent_end/session_stop to continue`,
				"warning",
			);
		}
	});

	// Primary recovery path — always emitted, even when session_stop is skipped.
	pi.on("agent_end", async (event, ctx) => {
		const message = lastAssistant(event.messages);
		await scheduleContinue(message, ctx, "agent_end");
	});

	// Fallback for text-only error settles that do reach session_stop.
	pi.on("session_stop", async (event, ctx: ExtensionContext) => {
		return scheduleContinue(event.last_assistant_message, ctx, "session_stop");
	});
}
