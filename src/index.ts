/**
 * omp-patch
 *
 * 1) Transient stream retry — moved to stream-retry.ts; scheduled via setTimeout
 *    so handlers never sleep (host 30s handler timeout).
 * 2) Advisor presence UI — while advisors review a finished turn, show footer
 *    status + an above-editor widget (stock omp only shows a static "++" and
 *    Advisor cards after notes arrive).
 * 3) Compact tool UI — Claude Code–style one-line tool results (Ctrl+O expands).
 * 4) Advisor autoresume — when omp preserves a concern/blocker card after a
 *    terminal text answer, auto-continue so the agent weighs and acts on it.
 * 5) Goal magic sticky — re-inject ultrathink/orchestrate/workflowz notices on
 *    goal turns when the objective contains those keywords (stock skips
 *    goal-continuation).
 */
import { statSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { installAdvisorAutoresume } from "./advisor-autoresume.ts";
import {
	installCompactToolUi,
	isCompactToolsEnabled,
	toggleCompactTools,
} from "./compact-tools.ts";
import { installGoalMagicSticky } from "./goal-magic-sticky.ts";
import { installStreamRetry, isTransientStreamFailure, lastAssistant } from "./stream-retry.ts";

/** How long to keep "Advisor reviewing…" if no notes arrive (silent finish). */
const ADVISOR_SILENCE_MS = 120_000;
const ADVISOR_STATUS_KEY = "omp-patch-advisor";
const ADVISOR_WIDGET_KEY = "omp-patch-advisor";

type TimerHandle = ReturnType<ExtensionContext["setTimeout"]>;

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

/** mtime cache for readAdvisorEnabled; unset / stale → re-read. */
let advisorEnabledCache: { mtimeMs: number; value: boolean } | undefined;

/**
 * Best-effort: top-level block `advisor:` → same-indent `enabled:` in config.yml.
 * Inline form `advisor: { enabled: false }` is not supported → default true.
 * Assume on if unreadable.
 */
function readAdvisorEnabled(ctx: ExtensionContext): boolean {
	const path = `${resolveAgentDir(ctx)}/config.yml`;
	try {
		const { mtimeMs } = statSync(path);
		if (advisorEnabledCache && advisorEnabledCache.mtimeMs === mtimeMs) {
			return advisorEnabledCache.value;
		}
		const text = readFileSync(path, "utf8");
		const lines = text.split(/\r?\n/);
		let inAdvisor = false;
		let childIndent: string | undefined;
		let value = true;
		for (const line of lines) {
			if (!inAdvisor) {
				// Block form only; inline `advisor: { … }` intentionally ignored → default true.
				if (/^advisor:\s*(?:#.*)?$/.test(line)) {
					inAdvisor = true;
					childIndent = undefined;
				}
				continue;
			}
			if (line.trim() === "") continue;
			const leading = /^([ \t]*)/.exec(line)?.[1] ?? "";
			if (leading.length === 0) break;
			// Comment lines must not anchor the child indent.
			if (line.slice(leading.length).startsWith("#")) continue;
			if (childIndent === undefined) childIndent = leading;
			if (leading !== childIndent) continue;
			const m = /^enabled:\s*(true|false)\b/.exec(line.slice(childIndent.length));
			if (m) {
				value = m[1] === "true";
				break;
			}
		}
		advisorEnabledCache = { mtimeMs, value };
		return value;
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
		handler: async (_args, ctx) => {
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
			ctx.setTimeout(() => {
				if (ctx.hasUI) ctx.ui.setStatus("omp-patch-compact", undefined);
			}, 4_000);
		}
	});

	// ——— advisor autoresume (preserved concern/blocker cards) ———
	installAdvisorAutoresume(pi);

	// ——— goal magic sticky (objective keywords survive continuations) ———
	installGoalMagicSticky(pi);

	// ——— transient stream retry ———
	installStreamRetry(pi);

	// ——— advisor UI ———
	let advisorPending = false;
	let advisorStartedAt = 0;
	let advisorSilenceTimer: TimerHandle | undefined;
	let advisorTickTimer: TimerHandle | undefined;
	let lastUiCtx: ExtensionContext | undefined;

	const clearAdvisorTimers = (ctx?: ExtensionContext): void => {
		const c = ctx ?? lastUiCtx;
		if (advisorSilenceTimer) {
			if (c) c.clearTimer(advisorSilenceTimer);
			advisorSilenceTimer = undefined;
		}
		if (advisorTickTimer) {
			if (c) c.clearTimer(advisorTickTimer);
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
		clearAdvisorTimers(ctx);
		const ui = ctx ?? lastUiCtx;
		if (!ui?.hasUI) return;
		paintAdvisorUi(ui, mode, noteCount);
		if (mode === "notes" || mode === "silent") {
			ui.setTimeout(() => {
				if (!advisorPending && ui.hasUI) paintAdvisorUi(ui, "clear");
			}, 4_000);
		}
	};

	const startAdvisorPending = (ctx: ExtensionContext): void => {
		lastUiCtx = ctx;
		advisorPending = true;
		advisorStartedAt = Date.now();
		clearAdvisorTimers(ctx);
		paintAdvisorUi(ctx, "reviewing");
		advisorTickTimer = ctx.setInterval(() => {
			if (!advisorPending || !lastUiCtx?.hasUI) return;
			paintAdvisorUi(lastUiCtx, "reviewing");
		}, 1_000);
		advisorSilenceTimer = ctx.setTimeout(() => {
			stopAdvisorPending(lastUiCtx, "silent");
		}, ADVISOR_SILENCE_MS);
	};

	pi.on("turn_end", async (event, ctx) => {
		const last = event.message;
		// Advisors kick off on each primary turn_end; stock UI only shows "++".
		if (last?.role === "assistant" && (last.stopReason === "stop" || last.stopReason === "length")) {
			if (readAdvisorEnabled(ctx)) {
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

	pi.on("agent_end", async (event, ctx) => {
		const message = lastAssistant(event.messages);
		const stopReason =
			message && typeof message === "object" && "stopReason" in message
				? message.stopReason
				: undefined;
		// Refresh/keep reviewing UI after the primary stops (common wait state).
		if (!isTransientStreamFailure(message) && message && stopReason !== "error" && readAdvisorEnabled(ctx)) {
			if (!advisorPending) startAdvisorPending(ctx);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		clearAdvisorTimers(ctx);
		advisorPending = false;
		advisorStartedAt = 0;
		lastUiCtx = undefined;
	});
}
