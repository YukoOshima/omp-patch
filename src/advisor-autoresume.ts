/**
 * Auto-continue when omp 16.5.2+ preserves a concern/blocker advisor card
 * after a terminal text answer (stock leaves those cards idle until the user
 * types "继续" / presses . or c).
 *
 * Intentionally does NOT wake:
 * - nit / omitted severity (aside; never preserved as an idle card)
 * - Esc / cancel suppression (no recent terminal text answer)
 * - plan mode (mode_change === "plan")
 * - live steered turns (agent not idle)
 */
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

const MAX_CONSECUTIVE = 3;
const DEBOUNCE_MS = 350;
const TERMINAL_ANSWER_WINDOW_MS = 180_000;
const STATUS_KEY = "omp-patch-advisor-autoresume";

let enabled = true;
let consecutive = 0;
let inFlight = false;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let lastTerminalAnswerAt = 0;
let lastTriggeredCardKey: string | undefined;

export function isAdvisorAutoresumeEnabled(): boolean {
	return enabled;
}

export function setAdvisorAutoresumeEnabled(on: boolean): boolean {
	enabled = on;
	return enabled;
}

export function toggleAdvisorAutoresume(): boolean {
	enabled = !enabled;
	return enabled;
}

function isAdvisorCard(message: unknown): message is {
	role: "custom";
	customType: "advisor";
	content?: unknown;
	details?: { notes?: Array<{ note?: string; severity?: string; advisor?: string }> };
} {
	if (!message || typeof message !== "object") return false;
	const m = message as { role?: string; customType?: string };
	return m.role === "custom" && m.customType === "advisor";
}

function interruptingNotes(
	message: {
		details?: { notes?: Array<{ note?: string; severity?: string; advisor?: string }> };
		content?: unknown;
	},
): Array<{ note: string; severity: "concern" | "blocker"; advisor?: string }> {
	const notes = message.details?.notes;
	if (Array.isArray(notes) && notes.length > 0) {
		return notes
			.filter(
				(n): n is { note: string; severity: "concern" | "blocker"; advisor?: string } =>
					typeof n?.note === "string" && (n.severity === "concern" || n.severity === "blocker"),
			)
			.map(n => ({
				note: n.note,
				severity: n.severity,
				...(typeof n.advisor === "string" ? { advisor: n.advisor } : {}),
			}));
	}

	// Fallback: parse severity attributes from rendered <advisory> content.
	const content =
		typeof message.content === "string"
			? message.content
			: Array.isArray(message.content)
				? message.content
						.map(part =>
							part && typeof part === "object" && "type" in part && (part as { type?: string }).type === "text"
								? String((part as { text?: string }).text ?? "")
								: "",
						)
						.join("\n")
				: "";
	const out: Array<{ note: string; severity: "concern" | "blocker"; advisor?: string }> = [];
	const re =
		/<advisory\b([^>]*)>([\s\S]*?)<\/advisory>/gi;
	let match: RegExpExecArray | null;
	while ((match = re.exec(content)) !== null) {
		const attrs = match[1] ?? "";
		const body = (match[2] ?? "").trim();
		const sev = /\bseverity\s*=\s*"(concern|blocker)"/i.exec(attrs)?.[1]?.toLowerCase();
		if ((sev === "concern" || sev === "blocker") && body) {
			const advisor = /\badvisor\s*=\s*"([^"]*)"/i.exec(attrs)?.[1];
			out.push({
				note: body,
				severity: sev,
				...(advisor ? { advisor } : {}),
			});
		}
	}
	return out;
}

function isTerminalTextAssistantAnswer(message: unknown): boolean {
	if (!message || typeof message !== "object") return false;
	const m = message as { role?: string; stopReason?: string; content?: unknown[] };
	if (m.role !== "assistant" || m.stopReason !== "stop" || !Array.isArray(m.content)) return false;
	let hasText = false;
	for (const part of m.content) {
		if (!part || typeof part !== "object") return false;
		const p = part as { type?: string; text?: string };
		if (p.type === "toolCall") return false;
		if (p.type === "text") {
			if ((p.text ?? "").trim().length > 0) hasText = true;
			continue;
		}
		if (p.type === "thinking" || p.type === "redactedThinking" || p.type === "fallback") continue;
		return false;
	}
	return hasText;
}

function lastAssistant(messages: unknown[] | undefined): unknown {
	if (!Array.isArray(messages)) return undefined;
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i] as { role?: string } | undefined;
		if (m?.role === "assistant") return m;
	}
	return undefined;
}

function isPlanModeActive(ctx: ExtensionContext): boolean {
	try {
		const entries = ctx.sessionManager.getEntries() as Array<{ type?: string; mode?: string }>;
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i];
			if (e?.type !== "mode_change") continue;
			return e.mode === "plan";
		}
	} catch {
		// Ignore — if we cannot read mode, prefer continuing over silently dropping.
	}
	return false;
}

function cardKey(notes: Array<{ note: string; severity: string; advisor?: string }>): string {
	return notes.map(n => `${n.severity}:${n.advisor ?? ""}:${n.note.trim()}`).join("|");
}

function continuePrompt(notes: Array<{ note: string; severity: string; advisor?: string }>): string {
	const who = [...new Set(notes.map(n => n.advisor).filter(Boolean))].join(", ");
	const labels = notes.map(n => n.severity).join("/");
	const from = who ? ` from ${who}` : "";
	return [
		`Advisor ${labels}${from} arrived after the previous turn already finished (omp preserved the card instead of auto-steering).`,
		"Re-read the latest <advisory> card(s) above, weigh the guidance (do not blindly obey), and continue the interrupted work.",
		"Do not ask the user to restate the request.",
	].join(" ");
}

export function installAdvisorAutoresume(pi: ExtensionAPI): void {
	pi.registerCommand("advisor-autoresume", {
		description: "Toggle auto-continue for preserved advisor concern/blocker cards (default on)",
		handler: async (_args, ctx) => {
			const on = toggleAdvisorAutoresume();
			if (!on) {
				if (debounceTimer) {
					clearTimeout(debounceTimer);
					debounceTimer = undefined;
				}
			}
			if (ctx.hasUI) {
				ctx.ui.notify(
					`omp-patch: advisor autoresume ${on ? "on" : "off"} (concern/blocker only)`,
					"info",
				);
			}
		},
	});

	pi.on("session_start", async () => {
		consecutive = 0;
		lastTerminalAnswerAt = 0;
		lastTriggeredCardKey = undefined;
		if (debounceTimer) {
			clearTimeout(debounceTimer);
			debounceTimer = undefined;
		}
	});

	pi.on("session_switch", async () => {
		consecutive = 0;
		lastTerminalAnswerAt = 0;
		lastTriggeredCardKey = undefined;
		if (debounceTimer) {
			clearTimeout(debounceTimer);
			debounceTimer = undefined;
		}
	});

	pi.on("input", async () => {
		// User took the wheel — reset the consecutive autoresume budget.
		consecutive = 0;
	});

	pi.on("agent_start", async () => {
		if (debounceTimer) {
			clearTimeout(debounceTimer);
			debounceTimer = undefined;
		}
	});

	pi.on("agent_end", async (event) => {
		const last = lastAssistant(event.messages);
		if (isTerminalTextAssistantAnswer(last)) {
			lastTerminalAnswerAt = Date.now();
		}
	});

	pi.on("message_end", async (event, ctx) => {
		if (!enabled) return;
		if (!isAdvisorCard(event.message)) return;

		const notes = interruptingNotes(event.message);
		if (notes.length === 0) return;

		// Steered into a live turn — stock already woke the agent.
		if (!ctx.isIdle()) return;
		if (ctx.hasPendingMessages()) return;
		if (isPlanModeActive(ctx)) return;

		// Only bridge the 16.5.2 terminal-answer preserve path.
		if (
			lastTerminalAnswerAt <= 0 ||
			Date.now() - lastTerminalAnswerAt > TERMINAL_ANSWER_WINDOW_MS
		) {
			return;
		}

		const key = cardKey(notes);
		if (key && key === lastTriggeredCardKey) return;

		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			debounceTimer = undefined;
			void (async () => {
				if (!enabled || inFlight) return;
				if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
				if (isPlanModeActive(ctx)) return;
				if (
					lastTerminalAnswerAt <= 0 ||
					Date.now() - lastTerminalAnswerAt > TERMINAL_ANSWER_WINDOW_MS
				) {
					return;
				}
				if (consecutive >= MAX_CONSECUTIVE) {
					if (ctx.hasUI) {
						ctx.ui.notify(
							`omp-patch: advisor autoresume capped at ${MAX_CONSECUTIVE} consecutive continues`,
							"warning",
						);
					}
					return;
				}

				consecutive += 1;
				lastTriggeredCardKey = key;
				inFlight = true;
				try {
					if (ctx.hasUI) {
						const theme = ctx.ui.theme;
						ctx.ui.setStatus(
							STATUS_KEY,
							theme.fg("dim", `advisor autoresume · ${notes.map(n => n.severity).join("/")}`),
						);
						setTimeout(() => {
							if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
						}, 4_000);
					}

					pi.sendMessage(
						{
							customType: "omp-patch-advisor-autoresume",
							content: continuePrompt(notes),
							display: true,
							attribution: "agent",
						},
						{ triggerTurn: true, deliverAs: "nextTurn" },
					);
				} finally {
					inFlight = false;
				}
			})();
		}, DEBOUNCE_MS);
	});
}
