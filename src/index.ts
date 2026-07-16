/**
 * omp-patch
 *
 * 1) Transient stream retry — auto-continue after failures stock omp often
 *    refuses (resource_exhausted fail-fast, NGHTTP2 mid-toolCall, stream stall).
 * 2) Advisor presence UI — while advisors review a finished turn, show footer
 *    status + an above-editor widget (stock omp only shows a static "++" and
 *    Advisor cards after notes arrive).
 * 3) Compact tool UI — Claude Code–style one-line tool results (Ctrl+O expands).
 * 4) Advisor autoresume — when omp preserves a concern/blocker card after a
 *    terminal text answer, auto-continue so the agent weighs and acts on it.
 */
import { homedir } from "node:os";
import { sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { installAdvisorAutoresume } from "./advisor-autoresume.ts";
import {
	installCompactToolUi,
	isCompactToolsEnabled,
	toggleCompactTools,
} from "./compact-tools.ts";

const MAX_CONTINUATIONS = 3;
const FIRST_DELAY_MS = 5_000;
const CAPACITY_BASE_MS = 45_000;
const CAPACITY_JITTER_MS = 30_000;
/** Hard cap for capacity / provider-requested waits — never sleep 30m windows. */
const MAX_CAPACITY_WAIT_MS = 5 * 60 * 1000;

/** How long to keep "Advisor reviewing…" if no notes arrive (silent finish). */
const ADVISOR_SILENCE_MS = 120_000;
const ADVISOR_STATUS_KEY = "omp-patch-advisor";
const ADVISOR_WIDGET_KEY = "omp-patch-advisor";

const TRANSIENT_FAILURE_RE =
	/resource[\s_]?exhausted|exceeds retry\.maxDelayMs|stream stalled|timed out while waiting for the first event|stream stall|NGHTTP2(?:_INTERNAL_ERROR)?|Stream closed with error code|HTTP2(?:StreamReset|INTERNAL_ERROR)/i;

function parseProviderWaitMs(err: string): number | undefined {
	const m = /Provider requested (\d+)ms wait/i.exec(err);
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
	if (/NGHTTP2|Stream closed with error code|HTTP2(?:StreamReset|INTERNAL_ERROR)/i.test(err)) {
		return "The previous turn failed on a transient HTTP/2 stream reset (e.g. NGHTTP2_INTERNAL_ERROR). Continue the interrupted work from where you left off; do not ask the user to restate the request.";
	}
	return "The previous turn failed on a transient provider/stream error. Continue the interrupted work from where you left off; do not ask the user to restate the request.";
}

function isAdvisorCustomMessage(message: unknown): boolean {
	if (!message || typeof message !== "object") return false;
	const m = message as { customType?: string };
	return m.customType === "advisor";
}

function advisorNoteCount(message: unknown): number | undefined {
	if (!message || typeof message !== "object") return undefined;
	const details = (message as { details?: { notes?: unknown[] } }).details;
	if (!details || !Array.isArray(details.notes)) return undefined;
	return details.notes.length;
}

function resolveAgentDir(ctx: ExtensionContext): string {
	try {
		const sessionFile = ctx.sessionManager.getSessionFile?.() as string | undefined;
		if (sessionFile) {
			const needle = `${sep}sessions${sep}`;
			const cut = sessionFile.lastIndexOf(needle);
			if (cut >= 0) return sessionFile.slice(0, cut);
		}
	} catch {
		/* ignore */
	}
	return `${homedir()}/.omp/agent`;
}

/** Best-effort: top-level `advisor.enabled` in config.yml (assume on if unreadable). */
async function readAdvisorEnabled(ctx: ExtensionContext): Promise<boolean> {
	try {
		const text = await Bun.file(`${resolveAgentDir(ctx)}/config.yml`).text();
		const lines = text.split(/\r?\n/);
		let inAdvisor = false;
		for (const line of lines) {
			if (/^advisor:\s*(?:#.*)?$/.test(line)) {
				inAdvisor = true;
				continue;
			}
			if (inAdvisor) {
				if (/^\S/.test(line)) break;
				const m = /^[ \t]+enabled:\s*(true|false)\b/.exec(line);
				if (m) return m[1] === "true";
			}
		}
		return true;
	} catch {
		return true;
	}
}

export default async function ompPatch(pi: ExtensionAPI): Promise<void> {
	pi.setLabel("omp-patch");

	// ——— compact tool UI (Claude Code–style) ———
	const compact = installCompactToolUi(pi);
	// Widen coverage (vibe/task/browser/…) when host toolRenderers is reachable.
	const compactFinal = await compact.ready;
	pi.registerCommand("compact-tools", {
		description: "Toggle compact tool results (one-liner; Ctrl+O expands)",
		handler: async (ctx) => {
			const on = toggleCompactTools();
			if (ctx.hasUI) {
				ctx.ui.notify(`omp-patch: compact tools ${on ? "on" : "off"} — Ctrl+O expands`, "info");
			}
		},
	});
	pi.on("session_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		const n = compactFinal.patched.length;
		if (n > 0 && isCompactToolsEnabled()) {
			const taskTag = compactFinal.taskInstancePatched ? " +task" : "";
			ctx.ui.setStatus(
				"omp-patch-compact",
				ctx.ui.theme.fg("dim", `compact tools · ${n}${taskTag}`),
			);
			setTimeout(() => {
				if (ctx.hasUI) ctx.ui.setStatus("omp-patch-compact", undefined);
			}, 4_000);
		}
	});

	// ——— advisor autoresume (preserved concern/blocker cards) ———
	installAdvisorAutoresume(pi);

	// ——— transient stream retry ———
	let consecutive = 0;
	let inFlight = false;
	let handledErrorKey: string | undefined;

	// ——— advisor UI ———
	let advisorPending = false;
	let advisorStartedAt = 0;
	let advisorSilenceTimer: ReturnType<typeof setTimeout> | undefined;
	let advisorTickTimer: ReturnType<typeof setInterval> | undefined;
	let lastUiCtx: ExtensionContext | undefined;

	const clearAdvisorTimers = (): void => {
		if (advisorSilenceTimer) {
			clearTimeout(advisorSilenceTimer);
			advisorSilenceTimer = undefined;
		}
		if (advisorTickTimer) {
			clearInterval(advisorTickTimer);
			advisorTickTimer = undefined;
		}
	};

	const paintAdvisorUi = (
		ctx: ExtensionContext,
		mode: "reviewing" | "notes" | "silent" | "clear",
		noteCount?: number,
	): void => {
		if (!ctx.hasUI) return;
		const theme = ctx.ui.theme;
		if (mode === "clear") {
			ctx.ui.setStatus(ADVISOR_STATUS_KEY, undefined);
			ctx.ui.setWidget(ADVISOR_WIDGET_KEY, undefined);
			return;
		}
		if (mode === "reviewing") {
			const elapsed = Math.max(0, Math.round((Date.now() - advisorStartedAt) / 1000));
			const spin = theme.fg("accent", "◆");
			ctx.ui.setStatus(ADVISOR_STATUS_KEY, `${spin}${theme.fg("dim", ` Advisor reviewing… ${elapsed}s`)}`);
			ctx.ui.setWidget(
				ADVISOR_WIDGET_KEY,
				[
					theme.fg("accent", "Advisor") + theme.fg("dim", " · reviewing the last turn"),
					theme.fg(
						"dim",
						"Waiting for notes (or a silent finish). Agent Hub → advisor transcript for live detail.",
					),
				],
				{ placement: "aboveEditor" },
			);
			return;
		}
		if (mode === "notes") {
			const n = noteCount ?? 0;
			const check = theme.fg("success", "✓");
			ctx.ui.setStatus(ADVISOR_STATUS_KEY, `${check}${theme.fg("dim", ` Advisor · ${n} note${n === 1 ? "" : "s"}`)}`);
			ctx.ui.setWidget(ADVISOR_WIDGET_KEY, undefined);
			return;
		}
		const check = theme.fg("dim", "✓");
		ctx.ui.setStatus(ADVISOR_STATUS_KEY, `${check}${theme.fg("dim", " Advisor · no notes")}`);
		ctx.ui.setWidget(ADVISOR_WIDGET_KEY, undefined);
	};

	const stopAdvisorPending = (
		ctx: ExtensionContext | undefined,
		mode: "notes" | "silent" | "clear",
		noteCount?: number,
	): void => {
		if (!advisorPending && mode === "clear") {
			if (ctx?.hasUI) paintAdvisorUi(ctx, "clear");
			return;
		}
		advisorPending = false;
		clearAdvisorTimers();
		const ui = ctx ?? lastUiCtx;
		if (!ui?.hasUI) return;
		paintAdvisorUi(ui, mode, noteCount);
		if (mode === "notes" || mode === "silent") {
			setTimeout(() => {
				if (!advisorPending && ui.hasUI) paintAdvisorUi(ui, "clear");
			}, 4_000);
		}
	};

	const startAdvisorPending = (ctx: ExtensionContext): void => {
		lastUiCtx = ctx;
		advisorPending = true;
		advisorStartedAt = Date.now();
		clearAdvisorTimers();
		paintAdvisorUi(ctx, "reviewing");
		advisorTickTimer = setInterval(() => {
			if (!advisorPending || !lastUiCtx?.hasUI) return;
			paintAdvisorUi(lastUiCtx, "reviewing");
		}, 1_000);
		advisorSilenceTimer = setTimeout(() => {
			stopAdvisorPending(lastUiCtx, "silent");
		}, ADVISOR_SILENCE_MS);
	};

	const capacityDedupeKey = (err: string): string | undefined => {
		if (/resource[\s_]?exhausted|exceeds retry\.maxDelayMs/i.test(err)) {
			// Collapse stock fail-fast wrapper + original Connect error so
			// auto_retry_end and agent_end do not double-continue.
			return "capacity:resource_exhausted";
		}
		return undefined;
	};

	const scheduleContinue = async (
		message: unknown,
		ctx: ExtensionContext,
		via: "agent_end" | "session_stop" | "auto_retry_end",
	): Promise<{ continue: true; additionalContext: string } | undefined> => {
		if (inFlight) return;
		if (!isTransientStreamFailure(message)) {
			consecutive = 0;
			handledErrorKey = undefined;
			return;
		}

		const err = errorText(message) || "transient stream error";
		const stamp = String((message as { timestamp?: number }).timestamp ?? "");
		const dedupeKey = capacityDedupeKey(err) ?? `${err}:${stamp}`;
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
		const delayMs = Math.round(capacityDelayMs(consecutive, err));

		if (ctx.hasUI) {
			const waitLabel =
				delayMs >= 60_000
					? `${Math.round(delayMs / 60_000)}m`
					: `${Math.round(delayMs / 1000)}s`;
			ctx.ui.notify(
				`omp-patch (${via}): ${err.slice(0, 70)} — retrying in ${waitLabel} (${consecutive}/${MAX_CONTINUATIONS})`,
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

	pi.on("turn_end", async (event, ctx) => {
		const last = event.message;
		if (last?.role === "assistant" && last.stopReason !== "error") {
			consecutive = 0;
			handledErrorKey = undefined;
		}
		// Advisors kick off on each primary turn_end; stock UI only shows "++".
		if (last?.role === "assistant" && (last.stopReason === "stop" || last.stopReason === "length")) {
			if (await readAdvisorEnabled(ctx)) {
				startAdvisorPending(ctx);
			}
		}
	});

	pi.on("message_end", async (event, ctx) => {
		if (!isAdvisorCustomMessage(event.message)) return;
		const n = advisorNoteCount(event.message);
		stopAdvisorPending(ctx, "notes", n);
		if (ctx.hasUI && n !== undefined) {
			ctx.ui.notify(`Advisor returned ${n} note${n === 1 ? "" : "s"}`, "info");
		}
	});

	pi.on("agent_start", async (_event, ctx) => {
		if (advisorPending) stopAdvisorPending(ctx, "clear");
	});

	pi.on("session_switch", async (_event, ctx) => {
		stopAdvisorPending(ctx, "clear");
	});

	pi.on("auto_retry_end", async (event, ctx) => {
		if (event.success) {
			consecutive = 0;
			handledErrorKey = undefined;
			return;
		}
		const err = event.finalError ?? "";
		if (!TRANSIENT_FAILURE_RE.test(err)) return;
		// Stock refused a long provider wait (e.g. 30m > retry.maxDelayMs).
		// Continue from here with wait capped at MAX_CAPACITY_WAIT_MS (5m) —
		// never sleep the full provider-requested delay.
		await scheduleContinue(
			{
				role: "assistant",
				stopReason: "error",
				errorMessage: err,
				timestamp: Date.now(),
			},
			ctx,
			"auto_retry_end",
		);
	});

	pi.on("agent_end", async (event, ctx) => {
		const message = lastAssistant(event.messages);
		// Refresh/keep reviewing UI after the primary stops (common wait state).
		if (
			!isTransientStreamFailure(message) &&
			message &&
			typeof message === "object" &&
			(message as { stopReason?: string }).stopReason !== "error" &&
			(await readAdvisorEnabled(ctx))
		) {
			if (!advisorPending) startAdvisorPending(ctx);
		}
		await scheduleContinue(message, ctx, "agent_end");
	});

	pi.on("session_stop", async (event, ctx: ExtensionContext) => {
		return scheduleContinue(event.last_assistant_message, ctx, "session_stop");
	});
}
