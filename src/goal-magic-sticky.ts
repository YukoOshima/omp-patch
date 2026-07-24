/**
 * Sticky magic-keyword notices for goal mode.
 *
 * Stock omp only injects ultrathink / orchestrate / workflowz notices when a
 * real user (or skill-args) prompt contains the standalone keyword. Goal
 * auto-continuations skip that path, so keywords written into the goal
 * objective would only fire on the first auto-submitted turn.
 *
 * This extension re-injects the missing notices on later turns when:
 * - the active goal's objective contains the keyword(s)
 * - the goal is enabled + status active (paused/dropped → off)
 * - magicKeywords.* settings still allow the keyword
 * - stock would not already inject on this turn
 * - for workflowz: the `task` tool is active
 *
 * Main-session only: state is keyed by session id; subagents never receive
 * parent `goal_updated`, so they never sticky-inject.
 *
 * Notice text mirrors stock omp prompts (ultrathink / orchestrate / workflow
 * notices). Detection uses the same prose-boundary rules as stock magic
 * keywords (standalone lowercase word; not glued into identifiers/paths).
 */
import { homedir } from "node:os";
import { sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

export const GOAL_MAGIC_CUSTOM_TYPE = "omp-patch-goal-magic";

type MagicKeyword = "ultrathink" | "orchestrate" | "workflow";

const KEYWORD_ORDER: readonly MagicKeyword[] = ["ultrathink", "orchestrate", "workflow"];

interface StickyState {
	objective: string;
	keywords: MagicKeyword[];
}

interface MagicKeywordSettings {
	enabled: boolean;
	ultrathink: boolean;
	orchestrate: boolean;
	workflow: boolean;
	taskBatch: boolean;
}

/** Per-session sticky cache (avoids leaking main-goal state into in-process subagents). */
const stickyBySession = new Map<string, StickyState>();

// Stock boundary rules from modes/magic-keyword-boundary.ts
const LEFT_BOUNDARY = String.raw`(?<![\p{L}\p{N}_./\\-])(?<!::)`;
const RIGHT_BOUNDARY = String.raw`(?![\p{L}\p{N}_/\\-])(?!\.[\p{L}\p{N}_-])(?!\()`;

function magicKeywordRegex(keyword: string): RegExp {
	return new RegExp(`${LEFT_BOUNDARY}${keyword.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&")}${RIGHT_BOUNDARY}`, "u");
}

const WORD: Record<MagicKeyword, RegExp> = {
	ultrathink: magicKeywordRegex("ultrathink"),
	orchestrate: magicKeywordRegex("orchestrate"),
	workflow: magicKeywordRegex("workflowz"),
};

/** Lightweight prose check: mask fenced/inline code + XML-ish tags, then test. */
function containsKeyword(text: string, keyword: MagicKeyword): boolean {
	const word = WORD[keyword];
	if (!word.test(text)) return false;
	const masked = text
		.replace(/```[\s\S]*?```/g, m => " ".repeat(m.length))
		.replace(/`[^`\n]+`/g, m => " ".repeat(m.length))
		.replace(/<\/?[A-Za-z][^>]*>/g, m => " ".repeat(m.length));
	return word.test(masked);
}

const ULTRATHINK_NOTICE = `<system-notice>
This task involves multi-step reasoning. Think carefully through the problem before responding.
</system-notice>`;

const ORCHESTRATE_NOTICE = `<system-notice>
The user's message above is an **orchestration request**. Execute it as the orchestrator under the contract below. This contract overrides any default tendency to yield early, narrate, or do the work yourself.

<role>
You decompose, dispatch, verify, and iterate. Substantial and parallelizable work goes through \`task\` subagents — that is the whole point of orchestrating. But you are not forbidden from touching the tree: a trivial, self-contained edit is yours to make directly when spawning a subagent for it would cost more than the edit itself. Your tool budget is: reading for planning, \`task\` for dispatch, \`edit\`/\`write\` for trivial inline fixes only, verification (\`bun check\`, \`bun test\`, \`lsp diagnostics\`), git via \`bash\`, and \`todo\` for tracking.
</role>

<rules>
1. **NEVER yield until everything is closed.** A phase finishing is *not* a yield point — launch the next phase in the same turn. Stop only when every requested item is verifiably done, or you hit a concrete [blocked] state that genuinely requires the user.
2. **Enumerate the full surface before dispatching.** If the request references audits, plans, checklists, phase lists, or file lists, expand them into a flat set of items in \`todo\`. "Most of them" or "the important ones" is failure. Re-read the source documents — NEVER work from memory.
3. **Parallelize maximally; NEVER launch a one-off task.** Every set of edits with disjoint file scope MUST ship as parallel \`task\` calls in one message — fan the work as wide as it decomposes. Dispatching divisible work one call at a time, serially, is a failure: split it and dispatch together. If you are about to dispatch exactly one subagent, stop — either there is more to run alongside it (find it and dispatch them together) or the change is small enough to make inline yourself (do it). Serialize only when one subagent produces a contract (types, schema, shared module) the next consumes — and state the dependency when you do.
4. **Each \`task\` assignment is self-contained.** Subagents have no shared context. Spell out: target files (≤3–5 explicit paths, no globs), the change with APIs and patterns, edge cases, and observable acceptance criteria. NEVER assume they read the same plan you did.
5. **Verify after every phase before launching the next.** Run the appropriate gate: \`bun check\` for types, package-scoped \`bun test\` for behavior, \`lsp diagnostics\` for changed files. If a phase introduced breakage, dispatch fix-up subagents *before* moving on. NEVER declare a phase done on a red tree.
6. **Commit policy.** If the request asks for commits or the repo workflow expects them, commit after each green phase with a focused message. NEVER commit a red tree. NEVER commit work the user did not ask to commit.
7. **Respawn, do not absorb.** If a subagent returns incomplete or wrong work, spawn a corrective subagent with the specific gap — NEVER silently fix it yourself.
8. **No scope creep, no scope shrink.** NEVER add work the user did not ask for. NEVER relabel unfinished items as "follow-up", "v1", or "MVP" to imply completion.
9. **Subagents do not verify, lint, or format.** Every \`task\` assignment MUST instruct the subagent to skip all gates and formatters. Their job is the edit only. You — the orchestrator — run verification and formatting **once** at the end of the phase across the union of changed files. Avoids redundant runs and racing formatter passes.
10. **Right-size the offload — do not micro-task.** Subagents are for substantial or parallelizable chunks, not every keystroke. A trivial, self-contained mechanical edit — deleting a redundant glob, fixing one line in a config, renaming a single symbol in one file — costs less to *do* than to describe in a Goal/Constraints assignment. Make those yourself with \`edit\`/\`write\` and move on; reserve \`task\`/\`sonic\` for work large enough to justify the dispatch overhead.
</rules>

<workflow>
1. **Ingest.** Read every referenced file (audits, plans, prior agent output, current branch state). Run \`git status\` to see uncommitted changes.
2. **Plan.** Materialize the full work surface in \`todo\` as ordered phases. Within each phase, list the parallelizable units.
3. **Dispatch phase.** Launch all parallel \`task\` subagents in one message, then collect every result (async results / \`hub\` wait) before moving on.
4. **Verify phase.** Run the gates. On failure, dispatch fix-up subagents and re-verify. Do not advance with a red gate.
5. **Commit phase** (if applicable). Focused message naming the phase.
6. **Advance.** Mark the phase done in \`todo\`, immediately start the next phase. No summary message between phases — keep going.
7. **Final verification.** When the last phase is green, run the full gate set once more and confirm every \`todo\` item is closed. Then yield with a terse status, not a recap.
</workflow>

<anti-patterns>
- Doing substantial or parallelizable work yourself instead of fanning it out to subagents.
- Wrapping a single trivial edit (e.g. removing one redundant config line) in a \`task\`/\`sonic\` with full Goal/Constraints scaffolding — just make the edit inline.
- Yielding after phase 1 with "ready to continue?".
- Dispatching one subagent at a time when five could run in parallel.
- Skipping \`bun check\` between phases because "the change looked safe".
- Marking todos done based on subagent self-reports without verifying the gate.
- Summarizing progress in chat instead of advancing to the next phase.
</anti-patterns>
</system-notice>`;

function renderWorkflowNotice(taskBatch: boolean): string {
	const fanout = taskBatch ? "for batched fan-out" : "once per independent subagent";
	const structureVerb = taskBatch ? "batch the independent leaves" : "issue one independent task call per leaf in the same turn";
	const contract = taskBatch
		? `Call \`task\` once per independent fan-out batch. Put shared background in \`context\`, and put each independent work item in \`tasks[]\`. Do not emulate batching with shell loops or eval helper APIs.

\`context\` must carry the shared contract:

    # Goal
    What the batch accomplishes.
    # Constraints
    Rules, non-goals, permissions, and verification limits.
    # Contract
    Shared interfaces, output shape, branch/base assumptions, and coordination rules.

Each task assignment must be self-contained:

    # Target
    Exact files, symbols, subsystem, or evidence surface; explicit non-goals.
    # Change
    What to inspect or modify, step by step, including APIs and patterns to reuse.
    # Acceptance
    Observable result, return packet, and local verification. Subagents skip formatters,
    linters, and project-wide tests; the parent runs shared proof once.`
		: `Call \`task\` once per independent subagent. Put the full shared background and the leaf work in that call's \`assignment\`. Do not pass \`context\` or \`tasks[]\`: the flat task schema rejects them when batch calls are disabled.

Each assignment must be self-contained:

    # Target
    Exact files, symbols, subsystem, or evidence surface; explicit non-goals.
    # Change
    Shared background plus what to inspect or modify, step by step, including APIs and patterns to reuse.
    # Acceptance
    Observable result, return packet, and local verification. Subagents skip formatters,
    linters, and project-wide tests; the parent runs shared proof once.`;

	const example = taskBatch
		? `    task(
      context: "# Goal\\nReview the auth diff…\\n# Constraints\\nRead-only…\\n# Contract\\nReturn findings as severity/file/line/fix…",
      tasks: [
        { id: "AuthOwner", role: "Auth Storage Reviewer", assignment: "# Target\\npackages/ai/src/auth-storage.ts\\n# Change\\nTrace credential selection…\\n# Acceptance\\nReturn confirmed findings only…" },
        { id: "PromptOwner", role: "Prompt Contract Reviewer", assignment: "# Target\\npackages/coding-agent/src/prompts/**\\n# Change\\nCheck active-tool guidance…\\n# Acceptance\\nReturn mismatches and exact prompt lines…" },
      ]
    )`
		: `    task(
      role: "Auth Storage Reviewer",
      assignment: "# Target\\npackages/ai/src/auth-storage.ts\\n# Change\\nReview the auth diff. Shared contract: read-only; return findings as severity/file/line/fix.\\n# Acceptance\\nReturn confirmed findings only…"
    )
    task(
      role: "Prompt Contract Reviewer",
      assignment: "# Target\\npackages/coding-agent/src/prompts/**\\n# Change\\nCheck active-tool guidance. Shared contract: read-only; return mismatches and exact prompt lines.\\n# Acceptance\\nReturn confirmed findings only…"
    )`;

	const prefer = taskBatch
		? "Prefer one wide batch over serial subagent calls when work items do not share files. If tasks overlap, name the overlap and have agents coordinate through IRC before editing."
		: "Prefer issuing all independent task calls in one assistant turn over serial dispatch when work items do not share files. If tasks overlap, name the overlap and have agents coordinate through IRC before editing.";

	const execBatch = taskBatch
		? "- Batch independent subagents in one `task` call."
		: "- Dispatch independent subagents as separate `task` calls in the same turn.";

	return `<system-notice>
The user's message above contains the **workflowz** keyword: drive this task as a deterministic multi-subagent workflow. Use the \`task\` tool ${fanout} — to be comprehensive (decompose and cover in parallel), to be confident (independent perspectives and adversarial checks before you commit), or to take on scale one context can't hold (audits, migrations, broad sweeps). This overrides any default tendency to do the whole task inline when fanning out would be more thorough.

<when>
Worth it when the task benefits from decomposition + parallel coverage, or from independent/adversarial cross-checking before you commit. For a quick lookup or single edit, just do it directly — don't spin up agents. Scout inline first (list the files, scope the diff, find the call sites) to discover the work list, then fan out over it. Common shapes:
- **Understand** — parallel readers over subsystems → structured map.
- **Design** — independent approaches → scored synthesis.
- **Review** — split dimensions → find per dimension → adversarially verify each finding.
- **Research** — multi-modal sweep → deep-read the hits → synthesize.
- **Migrate** — discover sites → transform each → verify.
</when>

<task-contract>
${contract}
</task-contract>

<structure>
Decompose first, then ${structureVerb}:

${example}

${prefer}
</structure>

<patterns>
- **Adversarial verify** — dispatch skeptical reviewers with distinct targets, then keep only findings the parent can verify against source.
- **Perspective-diverse review** — use separate correctness, security, performance, and maintainability roles instead of identical reviewers.
- **Completeness critic** — after the first batch, dispatch one read-only critic that asks what modality, file, claim, or proof was missed.
- **No silent caps** — if you bound coverage (top-N, no retry, sampling), state what was dropped and why before acting.
- **Parent owns closure** — subagents return evidence; the parent reads it, resolves contradictions, runs proof, and makes the final decision.
</patterns>

<execution>
- Capture multi-phase workflow state in the visible todo system when available.
${execBatch}
- Give every subagent a narrow target, explicit non-goals, and a concrete return packet.
- After fan-out returns, read the artifacts, patch or decide, and run the shared gate.
- Keep going until the task is closed — returned fan-out is a step, not a stopping point.
</execution>
</system-notice>`;
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

/**
 * Best-effort parse of magicKeywords.* + task.batch from config.yml.
 * Unreadable file → null (fail-closed: do not inject).
 * Missing keys → stock defaults (enabled).
 */
async function readMagicSettings(ctx: ExtensionContext): Promise<MagicKeywordSettings | null> {
	try {
		const text = await Bun.file(`${resolveAgentDir(ctx)}/config.yml`).text();
		const settings: MagicKeywordSettings = {
			enabled: true,
			ultrathink: true,
			orchestrate: true,
			workflow: true,
			taskBatch: true,
		};

		let section: "root" | "magic" | "task" | "other" = "root";
		for (const raw of text.split(/\r?\n/)) {
			const line = raw.replace(/\s+#.*$/, "");
			if (/^magicKeywords:\s*$/.test(line)) {
				section = "magic";
				continue;
			}
			if (/^task:\s*$/.test(line)) {
				section = "task";
				continue;
			}
			if (/^\S/.test(line) && !/^(magicKeywords|task):/.test(line)) {
				section = "other";
			}

			if (section === "magic") {
				const m = /^[ \t]+(enabled|ultrathink|orchestrate|workflow):\s*(true|false)\b/.exec(line);
				if (m) {
					const key = m[1] as keyof Omit<MagicKeywordSettings, "taskBatch">;
					settings[key] = m[2] === "true";
				}
			} else if (section === "task") {
				const m = /^[ \t]+batch:\s*(true|false)\b/.exec(line);
				if (m) settings.taskBatch = m[2] === "true";
			}
		}
		return settings;
	} catch {
		return null;
	}
}

function detectKeywords(objective: string): MagicKeyword[] {
	const found: MagicKeyword[] = [];
	for (const keyword of KEYWORD_ORDER) {
		if (containsKeyword(objective, keyword)) found.push(keyword);
	}
	return found;
}

/** Goal continuation templates embed the objective; stock never scans them for magic keywords. */
export function isGoalContinuationPrompt(prompt: string): boolean {
	return (
		prompt.includes("Continue work on the active goal") && /<objective\b[\s\S]*?<\/objective>/i.test(prompt)
	);
}

function noticeFor(keyword: MagicKeyword, taskBatch: boolean): string {
	switch (keyword) {
		case "ultrathink":
			return ULTRATHINK_NOTICE;
		case "orchestrate":
			return ORCHESTRATE_NOTICE;
		case "workflow":
			return renderWorkflowNotice(taskBatch);
	}
}

function sessionId(ctx: ExtensionContext): string {
	try {
		return ctx.sessionManager.getSessionId?.() ?? ctx.sessionManager.getSessionFile?.() ?? "unknown";
	} catch {
		return "unknown";
	}
}

function updateStickyFromGoal(
	ctx: ExtensionContext,
	goal: { objective?: string; status?: string } | null | undefined,
	state: { enabled?: boolean } | null | undefined,
): void {
	const sid = sessionId(ctx);
	if (!goal || state?.enabled !== true || goal.status !== "active") {
		stickyBySession.delete(sid);
		return;
	}
	const objective = typeof goal.objective === "string" ? goal.objective : "";
	const keywords = detectKeywords(objective);
	if (keywords.length === 0) {
		stickyBySession.delete(sid);
		return;
	}
	stickyBySession.set(sid, { objective, keywords });
}

/**
 * Whether stock `#createMagicKeywordNotices` would inject this keyword for `prompt`.
 * Goal continuations never go through that path.
 */
export function stockWouldInject(
	keyword: MagicKeyword,
	prompt: string,
	opts: { continuation: boolean; settings: MagicKeywordSettings; hasTaskTool: boolean },
): boolean {
	if (opts.continuation) return false;
	if (!opts.settings.enabled) return false;
	if (!opts.settings[keyword]) return false;
	if (keyword === "workflow" && !opts.hasTaskTool) return false;
	return containsKeyword(prompt, keyword);
}

export function installGoalMagicSticky(pi: ExtensionAPI): void {
	pi.on("goal_updated", (event, ctx) => {
		updateStickyFromGoal(ctx, event.goal ?? event.state?.goal, event.state);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		stickyBySession.delete(sessionId(ctx));
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const sticky = stickyBySession.get(sessionId(ctx));
		if (!sticky || sticky.keywords.length === 0) return;

		const settings = await readMagicSettings(ctx);
		if (!settings?.enabled) return;

		const hasTaskTool = pi.getActiveTools().includes("task");
		const continuation = isGoalContinuationPrompt(event.prompt);

		const injected: MagicKeyword[] = [];
		const parts: string[] = [];
		for (const keyword of KEYWORD_ORDER) {
			if (!sticky.keywords.includes(keyword)) continue;
			if (!settings[keyword]) continue;
			if (keyword === "workflow" && !hasTaskTool) continue;
			if (stockWouldInject(keyword, event.prompt, { continuation, settings, hasTaskTool })) continue;
			injected.push(keyword);
			parts.push(noticeFor(keyword, settings.taskBatch));
		}

		if (parts.length === 0) return;

		return {
			message: {
				customType: GOAL_MAGIC_CUSTOM_TYPE,
				content: parts.join("\n\n"),
				display: false,
				attribution: "user",
				details: {
					source: "goal-objective",
					keywords: injected,
				},
			},
		};
	});
}

/** Test helper: clear sticky cache. */
export function clearGoalMagicStickyState(): void {
	stickyBySession.clear();
}

/** Test helper: keyword detection used for objectives / prompts. */
export function __testContainsKeyword(text: string, keyword: MagicKeyword): boolean {
	return containsKeyword(text, keyword);
}
