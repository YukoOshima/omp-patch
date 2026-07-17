/**
 * Transient stream retry — auto-continue after failures stock omp often
 * refuses (resource_exhausted fail-fast, NGHTTP2 mid-toolCall, stream stall).
 *
 * Host constraints (omp 17.0.1, verified against shipped source):
 * - Every extension handler is bounded by a 30s timeout; on timeout the return
 *   value is discarded while the handler keeps running in the background. So
 *   handlers NEVER sleep: retries are scheduled via setTimeout and fired with
 *   pi.sendMessage(triggerTurn, deliverAs:"nextTurn"), which is timeout-immune.
 * - One terminal failure fans out to auto_retry_end → session_stop → agent_end.
 *   We ignore session_stop (its continue return value cannot survive a delayed
 *   retry) and dedupe the rest by error-class key; agent_start re-arms the key
 *   so the NEXT turn's identical failure is retried again.
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const MAX_CONTINUATIONS = 5;
const FIRST_DELAY_MS = 5_000;
const CAPACITY_BASE_MS = 45_000;
const CAPACITY_JITTER_MS = 30_000;
/** Hard cap for capacity / provider-requested waits — never sleep 30m windows. */
const MAX_CAPACITY_WAIT_MS = 5 * 60 * 1000;

const TRANSIENT_FAILURE_RE =
	/resource[\s_]?exhausted|exceeds retry\.maxDelayMs|stream stalled|timed out while waiting for the first event|stream stall|NGHTTP2(?:_INTERNAL_ERROR)?|Stream closed with error code|HTTP2(?:StreamReset|INTERNAL_ERROR)/i;

const CAPACITY_RE = /resource[\s_]?exhausted|exceeds retry\.maxDelayMs/i;

function parseProviderWaitMs(err: string): number | undefined {
	const m = /Provider requested (\d+(?:\.\d+)?)ms wait/i.exec(err);
	if (!m) return undefined;
	const n = Number(m[1]);
	return Number.isFinite(n) && n > 0 ? n : undefined;
}

function capacityDelayMs(attempt: number, err: string): number {
	const requested = parseProviderWaitMs(err);
	if (requested != null) {
		// e.g. provider asks 1800000ms (30m) → wait at most 5 minutes.
		return Math.min(requested, MAX_CAPACITY_WAIT_MS);
	}
	if (attempt <= 1) return FIRST_DELAY_MS;
	return Math.min(CAPACITY_BASE_MS + Math.random() * CAPACITY_JITTER_MS, MAX_CAPACITY_WAIT_MS);
}

function errorText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const m = message as { errorMessage?: string };
	return m.errorMessage ?? "";
}

export function isTransientStreamFailure(message: unknown): boolean {
	if (!message || typeof message !== "object") return false;
	const m = message as { role?: string; stopReason?: string; errorMessage?: string };
	if (m.role !== "assistant" || m.stopReason !== "error") return false;
	return TRANSIENT_FAILURE_RE.test(m.errorMessage ?? "");
}

export function lastAssistant(messages: unknown[] | undefined): unknown {
	if (!Array.isArray(messages)) return undefined;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string } | undefined;
		if (m?.role === "assistant") return m;
	}
	return undefined;
}

function continueHint(err: string): string {
	if (CAPACITY_RE.test(err)) {
		return "The previous turn failed on a transient Cursor/Connect resource_exhausted (model capacity) error. Continue the interrupted work from where you left off; do not ask the user to restate the request.";
	}
	if (/stalled|first event|stream stall/i.test(err)) {
		return "The previous turn failed because the provider stream stalled or timed out waiting for events. Continue the interrupted work from where you left off; do not ask the user to restate the request.";
	}
	if (/NGHTTP2|Stream closed with error code|HTTP2(?:StreamReset|INTERNAL_ERROR)/i.test(err)) {
		return "The previous turn failed on a transient HTTP/2 stream reset (e.g. NGHTTP2_INTERNAL_ERROR). Continue the interrupted work from where you left off; do not ask the user to restate the request.";
	}
	return "The previous turn failed on a transient provider/stream error. Continue the interrupted work from where you left off; do not ask the user to restate the request.";
}

/**
 * Timestamp-free dedupe key. One failure fans out to several events carrying
 * different timestamps (auto_retry_end synthesizes one, agent_end keeps the
 * original message's), so keys must key on the error class, not the instance.
 * agent_start re-arms the key between turns.
 */
function dedupeKeyFor(err: string): string {
	if (CAPACITY_RE.test(err)) return "capacity:resource_exhausted";
	return `transient:${err.slice(0, 200)}`;
}

/** Timer handle owned by this module (Bun/Node setTimeout return). */
type RetryTimer = ReturnType<typeof setTimeout>;

export function installStreamRetry(pi: ExtensionAPI): void {
	let consecutive = 0;
	let handledErrorKey: string | undefined;
	let pendingTimer: RetryTimer | undefined;

	const cancelPending = (): void => {
		if (pendingTimer) {
			clearTimeout(pendingTimer);
			pendingTimer = undefined;
		}
	};

	const reset = (): void => {
		consecutive = 0;
		handledErrorKey = undefined;
	};

	const scheduleContinue = (err: string, ctx: ExtensionContext, via: "agent_end" | "auto_retry_end"): void => {
		if (pendingTimer) return;

		const dedupeKey = dedupeKeyFor(err);
		if (handledErrorKey === dedupeKey) return;

		// Mark the instance handled BEFORE the cap check: a gave-up failure must
		// still dedupe its own fanout siblings, or they re-enter and schedule.
		handledErrorKey = dedupeKey;

		if (consecutive >= MAX_CONTINUATIONS) {
			if (ctx.hasUI) {
				ctx.ui.notify(`omp-patch: gave up after ${MAX_CONTINUATIONS} continues`, "error");
			}
			consecutive = 0;
			return;
		}

		consecutive += 1;
		const delayMs = Math.round(capacityDelayMs(consecutive, err));

		if (ctx.hasUI) {
			const waitLabel =
				delayMs >= 60_000 ? `${Math.round(delayMs / 60_000)}m` : `${Math.round(delayMs / 1000)}s`;
			ctx.ui.notify(
				`omp-patch (${via}): ${err.slice(0, 70)} — retrying in ${waitLabel} (${consecutive}/${MAX_CONTINUATIONS})`,
				"warning",
			);
		}

		pendingTimer = setTimeout(() => {
			pendingTimer = undefined;
			try {
				pi.sendMessage(
					{
						customType: "omp-patch-retry",
						content: continueHint(err),
						display: true,
					},
					{ triggerTurn: true, deliverAs: "nextTurn" },
				);
			} catch {
				// Session may be gone by fire time — a throw here would be an
				// uncaught timer exception and kill the host process.
			}
		}, delayMs);
		// Bun/Node timer handles expose unref(); the DOM-style typing does not.
		const handle: { unref?: () => void } = pendingTimer as unknown as { unref?: () => void };
		handle.unref?.();
	};

	/** Assistant-message entry (agent_end). Non-transient messages reset the budget. */
	const handleAssistantMessage = (message: unknown, ctx: ExtensionContext, via: "agent_end"): void => {
		if (!isTransientStreamFailure(message)) {
			// A pending retry means the terminal failure was already classified
			// transient via auto_retry_end (fail-fast wrapper); the raw assistant
			// error may not match the regex itself — don't leak the budget reset.
			if (!pendingTimer) reset();
			return;
		}
		scheduleContinue(errorText(message) || "transient stream error", ctx, via);
	};

	pi.on("agent_start", async () => {
		// New turn = new failure instance: re-arm dedupe so an identical error
		// in the upcoming turn is retried again. A starting turn also supersedes
		// any pending retry (e.g. the user continued manually). `consecutive`
		// intentionally survives — it caps consecutive FAILED continue turns.
		cancelPending();
		handledErrorKey = undefined;
	});

	pi.on("turn_end", async (event) => {
		const last = event.message;
		if (last?.role === "assistant" && last.stopReason !== "error") {
			// A successful turn makes any pending retry stale.
			cancelPending();
			reset();
		}
	});

	pi.on("auto_retry_end", async (event, ctx) => {
		if (event.success) {
			cancelPending();
			reset();
			return;
		}
		const err = event.finalError ?? "";
		if (!TRANSIENT_FAILURE_RE.test(err)) return;
		// Stock refused a long provider wait (e.g. 30m > retry.maxDelayMs) or
		// exhausted its retry budget on a transient error. Continue from here
		// with the wait capped at MAX_CAPACITY_WAIT_MS (5m).
		scheduleContinue(err, ctx, "auto_retry_end");
	});

	pi.on("agent_end", async (event, ctx) => {
		handleAssistantMessage(lastAssistant(event.messages), ctx, "agent_end");
	});

	pi.on("input", async () => {
		// User took the wheel — a pending auto-retry must not inject a spurious
		// continue into their turn (input fires before agent_start).
		cancelPending();
	});

	pi.on("session_start", async () => {
		cancelPending();
		reset();
	});

	pi.on("session_switch", async () => {
		cancelPending();
		reset();
	});
}
