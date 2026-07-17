/**
 * Claude Code–style compact tool UI.
 *
 * Collapsed: one status line (`✓ bash · git status`).
 * Expanded (Ctrl+O): original rich renderer output.
 *
 * Patches host tool renderers in place so builtins keep their real `execute`.
 * Prefers `api.pi.*ToolRenderer` (same module instance as the running TUI).
 * mergeCallAndResult follows compactEnabled via a getter, so toggling compact
 * off fully restores stock rendering.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const PATCHED = Symbol.for("omp-patch.compact-tools");

type ThemeLike = {
	fg: (color: string, text: string) => string;
	bold: (text: string) => string;
	spinnerFrames?: string[];
	styledSymbol: (key: string, color: string) => string;
};

type RenderOptions = {
	expanded: boolean;
	isPartial: boolean;
	spinnerFrame?: number;
};

type ToolRendererLike = {
	renderCall: (args: unknown, options: RenderOptions, theme: ThemeLike) => unknown;
	renderResult: (
		result: { content?: unknown; details?: unknown; isError?: boolean },
		options: RenderOptions,
		theme: ThemeLike,
		args?: unknown,
	) => unknown;
	mergeCallAndResult?: boolean;
	inline?: boolean;
	[PATCHED]?: boolean;
};

let compactEnabled = true;

export function isCompactToolsEnabled(): boolean {
	return compactEnabled;
}

export function setCompactToolsEnabled(enabled: boolean): boolean {
	compactEnabled = enabled;
	return compactEnabled;
}

export function toggleCompactTools(): boolean {
	compactEnabled = !compactEnabled;
	return compactEnabled;
}

function truncate(text: string, max: number): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	if (oneLine.length <= max) return oneLine;
	return `${oneLine.slice(0, Math.max(0, max - 1))}…`;
}

function firstString(args: Record<string, unknown>, keys: string[]): string | undefined {
	for (const key of keys) {
		const value = args[key];
		if (typeof value === "string" && value.trim()) return value;
	}
	return undefined;
}

/** Short arg summary for the collapsed one-liner. */
export function summarizeToolArgs(toolName: string, args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const a = args as Record<string, unknown>;

	switch (toolName) {
		case "bash":
		case "ssh":
			return truncate(String(a.command ?? ""), 72);
		case "read":
		case "write":
		case "edit":
		case "apply_patch":
		case "inspect_image":
			return truncate(String(a.path ?? a.file_path ?? ""), 72);
		case "grep":
		case "ast_grep":
		case "ast_edit": {
			const bits = [a.pattern, a.path, a.glob, a.target].filter(
				(v): v is string => typeof v === "string" && v.trim().length > 0,
			);
			return truncate(bits.join(" · "), 72);
		}
		case "glob":
			return truncate(String(a.pattern ?? a.glob ?? ""), 72);
		case "eval": {
			const lang = typeof a.language === "string" ? a.language : "";
			const code = typeof a.code === "string" ? a.code : typeof a.title === "string" ? a.title : "";
			return truncate([lang, code].filter(Boolean).join(" · "), 72);
		}
		case "web_search":
			return truncate(String(a.query ?? a.search_term ?? ""), 72);
		case "browser":
			return truncate(String(a.action ?? a.url ?? a.i ?? ""), 72);
		case "task": {
			const tasks = Array.isArray(a.tasks) ? (a.tasks as Array<Record<string, unknown>>) : null;
			if (tasks && tasks.length > 0) {
				const labels = tasks
					.map((t) => {
						if (!t || typeof t !== "object") return "";
						const name = typeof t.name === "string" ? t.name.trim() : "";
						const agent = typeof t.agent === "string" ? t.agent.trim() : "";
						return name || agent;
					})
					.filter(Boolean);
				const firstTask = typeof tasks[0]?.task === "string" ? tasks[0].task : "";
				const body = labels.length > 0 ? labels.join(",") : firstTask;
				return truncate(`${tasks.length}× ${body}`, 72);
			}
			const bits = [a.agent, a.name, a.task, a.prompt].filter(
				(v): v is string => typeof v === "string" && v.trim().length > 0,
			);
			return truncate(bits.join(" · "), 72);
		}
		case "vibe_spawn":
			return truncate(String(a.prompt ?? a.task ?? a.message ?? ""), 72);
		case "vibe_send":
			return truncate(String(a.message ?? a.text ?? ""), 72);
		case "todo": {
			const bits = [a.op, a.task ?? a.phase].filter(
				(v): v is string => typeof v === "string" && v.trim().length > 0,
			);
			return truncate(bits.join(" · "), 40);
		}
		default: {
			const hit = firstString(a, [
				"command",
				"path",
				"pattern",
				"query",
				"prompt",
				"message",
				"url",
				"name",
				"title",
				"i",
			]);
			return hit ? truncate(hit, 72) : "";
		}
	}
}

function statusIcon(theme: ThemeLike, options: RenderOptions, result?: { isError?: boolean }): string {
	if (options.spinnerFrame !== undefined || options.isPartial) {
		const frames = theme.spinnerFrames ?? ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
		const frame = options.spinnerFrame ?? 0;
		return theme.fg("accent", frames[frame % frames.length] ?? "·");
	}
	if (result?.isError) return theme.styledSymbol("status.error", "error");
	if (result) return theme.styledSymbol("status.success", "success");
	return theme.styledSymbol("status.pending", "muted");
}

function compactLine(
	Text: new (text: string, paddingX?: number, paddingY?: number) => unknown,
	toolName: string,
	args: unknown,
	options: RenderOptions,
	theme: ThemeLike,
	result?: { isError?: boolean },
): unknown {
	const icon = statusIcon(theme, options, result);
	const name = theme.fg("toolTitle", theme.bold(toolName));
	const summary = summarizeToolArgs(toolName, args);
	const detail = summary ? theme.fg("dim", ` · ${summary}`) : "";
	return new Text(`${icon} ${name}${detail}`, 0, 0);
}

function patchRenderer(
	toolName: string,
	renderer: ToolRendererLike,
	Text: new (text: string, paddingX?: number, paddingY?: number) => unknown,
): void {
	if (renderer[PATCHED]) return;

	const originalCall = renderer.renderCall.bind(renderer);
	const originalResult = renderer.renderResult.bind(renderer);

	renderer.renderCall = (args, options, theme) => {
		if (!compactEnabled) return originalCall(args, options, theme);
		if (options.expanded) return originalCall(args, options, theme);
		return compactLine(Text, toolName, args, options, theme);
	};

	renderer.renderResult = (result, options, theme, args) => {
		if (!compactEnabled) return originalResult(result, options, theme, args);
		if (options.expanded) return originalResult(result, options, theme, args);
		return compactLine(Text, toolName, args, options, theme, result);
	};

	// Prefer a single merged row while compact is on; restore stock when toggled off.
	const originalMerge = renderer.mergeCallAndResult === true;
	Object.defineProperty(renderer, "mergeCallAndResult", {
		configurable: true,
		enumerable: true,
		get: () => (compactEnabled ? true : originalMerge),
	});
	renderer[PATCHED] = true;
}

type ToolRenderersMap = Record<string, ToolRendererLike>;

/** Best-effort: load host `toolRenderers` (covers vibe/task/browser too). */
async function tryLoadHostToolRenderers(hostBash: ToolRendererLike | undefined): Promise<ToolRenderersMap | null> {
	try {
		const mod = (await import("@oh-my-pi/pi-coding-agent/tools/renderers")) as {
			toolRenderers?: ToolRenderersMap;
		};
		const map = mod.toolRenderers;
		if (!map?.bash) return null;
		if (hostBash && map.bash !== hostBash) return null; // different copy — refuse
		return map;
	} catch {
		return null;
	}
}

function patchExportRenderers(
	api: ExtensionAPI,
	Text: new (text: string, paddingX?: number, paddingY?: number) => unknown,
	patched: string[],
): void {
	const exportMap: Array<[string, unknown]> = [
		["bash", api.pi.bashToolRenderer],
		["read", api.pi.readToolRenderer],
		["write", api.pi.writeToolRenderer],
		["edit", api.pi.editToolRenderer],
		["apply_patch", api.pi.editToolRenderer],
		["grep", api.pi.grepToolRenderer],
		["glob", api.pi.globToolRenderer],
		["ask", api.pi.askToolRenderer],
		["ast_grep", api.pi.astGrepToolRenderer],
		["ast_edit", api.pi.astEditToolRenderer],
		["debug", api.pi.debugToolRenderer],
		["eval", api.pi.evalToolRenderer],
		["inspect_image", api.pi.inspectImageToolRenderer],
		["todo", api.pi.todoToolRenderer],
		["goal", api.pi.goalToolRenderer],
	];

	for (const [name, renderer] of exportMap) {
		const r = renderer as ToolRendererLike | undefined;
		if (!r?.renderCall || !r?.renderResult) continue;
		if (r[PATCHED]) {
			if (!patched.includes(name)) patched.push(name);
			continue;
		}
		patchRenderer(name, r, Text);
		patched.push(name);
	}
}

type TextCtor = new (text: string, paddingX?: number, paddingY?: number) => unknown;

type TaskToolLike = {
	renderCall?: (args: unknown, options: RenderOptions, theme: ThemeLike) => unknown;
	renderResult?: (
		result: { content?: unknown; details?: unknown; isError?: boolean },
		options: RenderOptions,
		theme: ThemeLike,
		args?: unknown,
	) => unknown;
	mergeCallAndResult?: boolean;
	[PATCHED]?: boolean | string;
};

type TaskToolCtor = {
	prototype: TaskToolLike & {
		renderCall: NonNullable<TaskToolLike["renderCall"]>;
	};
	create: (...args: unknown[]) => Promise<TaskToolLike>;
};

const TASK_CREATE_PATCHED = Symbol.for("omp-patch.compact-tools.task-create");

/**
 * Patch a live TaskTool instance.
 * tool-execution prefers instance renderCall/renderResult over toolRenderers.task.
 */
export function patchTaskToolInstance(tool: TaskToolLike, Text: TextCtor): boolean {
	if (!tool) return false;
	// Only skip when THIS instance was wrapped. Prototype carries a different
	// mark for renderCall and must not block instance renderResult wrapping.
	if (Object.prototype.hasOwnProperty.call(tool, PATCHED) && tool[PATCHED] === true) {
		return true;
	}
	const originalResult = tool.renderResult;
	if (typeof originalResult !== "function") return false;
	const boundResult = originalResult.bind(tool);

	tool.renderResult = (result, options, theme, args) => {
		if (!compactEnabled) return boundResult(result, options, theme, args);
		if (options.expanded) return boundResult(result, options, theme, args);
		return compactLine(Text, "task", args, options, theme, result);
	};
	const originalMerge = tool.mergeCallAndResult === true;
	Object.defineProperty(tool, "mergeCallAndResult", {
		configurable: true,
		enumerable: true,
		get: () => (compactEnabled ? true : originalMerge),
	});
	Object.defineProperty(tool, PATCHED, { value: true, configurable: true });
	return true;
}

/**
 * Patch TaskTool class: prototype.renderCall + wrap create() so every live
 * instance gets a compact renderResult. This is the real task UI path.
 */
export function patchTaskToolClass(TaskTool: TaskToolCtor, Text: TextCtor): boolean {
	if (!TaskTool?.prototype?.renderCall || typeof TaskTool.create !== "function") {
		throw new Error("omp-patch: patchTaskToolClass received unusable TaskTool");
	}

	if (TaskTool.prototype[PATCHED] !== "prototype") {
		const originalCall = TaskTool.prototype.renderCall;
		TaskTool.prototype.renderCall = function patchedTaskRenderCall(
			this: unknown,
			args: unknown,
			options: RenderOptions,
			theme: ThemeLike,
		) {
			if (!compactEnabled) return originalCall.call(this, args, options, theme);
			if (options.expanded) return originalCall.call(this, args, options, theme);
			return compactLine(Text, "task", args, options, theme);
		};
		// Mark prototype so we don't double-wrap renderCall; instances still need
		// their own renderResult wrap via create()/patchTaskToolInstance.
		Object.defineProperty(TaskTool.prototype, PATCHED, {
			value: "prototype",
			configurable: true,
		});
	}

	const ctor = TaskTool as TaskToolCtor & { [key: symbol]: unknown };
	if (!ctor[TASK_CREATE_PATCHED]) {
		const originalCreate = TaskTool.create.bind(TaskTool);
		TaskTool.create = async (...args: unknown[]) => {
			const tool = await originalCreate(...args);
			patchTaskToolInstance(tool, Text);
			return tool;
		};
		ctor[TASK_CREATE_PATCHED] = true;
	}

	return true;
}

export type CompactInstallMode =
	| "exports"
	| "toolRenderers"
	| "exports+toolRenderers"
	| "exports+task"
	| "exports+toolRenderers+task";

function isTaskToolCtor(value: unknown): value is TaskToolCtor {
	const T = value as TaskToolCtor | undefined;
	return !!T && typeof T.create === "function" && typeof T.prototype?.renderCall === "function";
}

/**
 * Resolve the live host TaskTool class.
 *
 * Prefer `api.pi.TaskTool` (the class the running TUI actually uses). Fall back
 * to the canonical string-literal import `@oh-my-pi/pi-coding-agent/task` when
 * the host has not exposed it yet (omp rewrites literal `@(scope)/pi-*` onto
 * the host instance; `import(variable)` is NOT rewritten).
 *
 * Do **not** require import and `api.pi.TaskTool` to be the same class identity:
 * plugins may resolve a different `@oh-my-pi/pi-coding-agent` copy than the
 * running omp binary (e.g. 16.5.2 vs 17.0.0). Host wins on mismatch.
 */
export async function resolveHostTaskTool(api: ExtensionAPI): Promise<TaskToolCtor> {
	const fromPi = (api.pi as { TaskTool?: TaskToolCtor } | undefined)?.TaskTool;
	if (isTaskToolCtor(fromPi)) {
		return fromPi;
	}

	// IMPORTANT: keep this as a string literal (not `import(spec)`).
	// omp's legacy-pi source rewriter only rewrites literal specifiers.
	let mod: { TaskTool?: TaskToolCtor };
	try {
		mod = (await import("@oh-my-pi/pi-coding-agent/task")) as { TaskTool?: TaskToolCtor };
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		throw new Error(
			`omp-patch: failed to import host TaskTool via @oh-my-pi/pi-coding-agent/task (${detail})`,
		);
	}

	const TaskTool = mod.TaskTool;
	if (!isTaskToolCtor(TaskTool)) {
		throw new Error(
			"omp-patch: @oh-my-pi/pi-coding-agent/task did not export a usable TaskTool (need create + prototype.renderCall)",
		);
	}

	return TaskTool;
}

export type CompactInstallResult = {
	patched: string[];
	mode: CompactInstallMode;
	taskInstancePatched: boolean;
};

/**
 * Install compact UI. Sync path patches exported host renderers immediately.
 * TaskTool patching is async: dynamically import the host task module (same
 * instance), then wrap prototype.renderCall + create(). tool-execution prefers
 * live TaskTool instance renderers over toolRenderers.task.
 */
export function installCompactToolUi(api: ExtensionAPI): CompactInstallResult & {
	ready: Promise<CompactInstallResult>;
} {
	const Text = api.pi.Text as TextCtor;
	const patched: string[] = [];
	const hostBash = api.pi.bashToolRenderer as ToolRendererLike | undefined;

	patchExportRenderers(api, Text, patched);

	// Do NOT trust api.pi.TaskTool synchronously — may be undefined on the
	// production extension path. Task patch happens in `ready`.
	let mode: CompactInstallMode = "exports";
	let taskInstancePatched = false;

	const ready = (async (): Promise<CompactInstallResult> => {
		// Task patch is best-effort: never abort the rest of omp-patch (stream
		// retry / advisor) when plugins resolve a different pi-coding-agent copy.
		try {
			const TaskTool = await resolveHostTaskTool(api);
			taskInstancePatched = patchTaskToolClass(TaskTool, Text);
			if (taskInstancePatched && !patched.includes("task")) patched.push("task");
		} catch {
			taskInstancePatched = false;
		}

		const map = await tryLoadHostToolRenderers(hostBash);
		if (map) {
			for (const name of Object.keys(map)) {
				const renderer = map[name];
				if (!renderer?.renderCall || !renderer?.renderResult) continue;
				// Map entry for task is not sufficient — only count task when
				// the live TaskTool instance path was patched.
				if (name === "task" && !taskInstancePatched) continue;
				if (Object.prototype.hasOwnProperty.call(renderer, PATCHED) || renderer[PATCHED]) {
					if (!patched.includes(name)) patched.push(name);
					continue;
				}
				patchRenderer(name, renderer, Text);
				if (!patched.includes(name)) patched.push(name);
			}
		}

		if (taskInstancePatched && map) {
			mode = "exports+toolRenderers+task";
		} else if (taskInstancePatched) {
			mode = "exports+task";
		} else if (map) {
			mode = "exports+toolRenderers";
		} else {
			mode = "exports";
		}

		return { patched: [...patched], mode, taskInstancePatched };
	})();

	return {
		patched,
		mode,
		taskInstancePatched,
		ready,
	};
}
