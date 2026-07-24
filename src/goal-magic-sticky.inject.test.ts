/**
 * Integration-style test: mock ExtensionAPI event bus and assert notice injection
 * on goal continuation vs skip on first user prompt that already contains the keyword.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
	clearGoalMagicStickyState,
	GOAL_MAGIC_CUSTOM_TYPE,
	installGoalMagicSticky,
} from "./goal-magic-sticky.ts";

type Handler = (event: any, ctx: ExtensionContext) => any;

function makeCtx(sessionFile: string, sessionId = "sess-main"): ExtensionContext {
	return {
		sessionManager: {
			getSessionFile: () => sessionFile,
			getSessionId: () => sessionId,
		},
	} as unknown as ExtensionContext;
}

function makePi(handlers: Map<string, Handler[]>, activeTools: string[] = ["task", "read"]): ExtensionAPI {
	return {
		on(event: string, handler: Handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		getActiveTools: () => activeTools,
	} as unknown as ExtensionAPI;
}

async function emit(handlers: Map<string, Handler[]>, event: string, payload: object, ctx: ExtensionContext) {
	const list = handlers.get(event) ?? [];
	let last: unknown;
	for (const h of list) {
		last = await h({ type: event, ...payload }, ctx);
	}
	return last;
}

function agentDirWithConfig(body = "setupVersion: 1\n"): { agentDir: string; sessionFile: string } {
	const agentDir = mkdtempSync(join(tmpdir(), "omp-patch-goal-magic-"));
	writeFileSync(join(agentDir, "config.yml"), body);
	const sessions = join(agentDir, "sessions", "proj");
	mkdirSync(sessions, { recursive: true });
	const sessionFile = join(sessions, "test.jsonl");
	writeFileSync(sessionFile, "");
	return { agentDir, sessionFile };
}

afterEach(() => {
	clearGoalMagicStickyState();
});

describe("installGoalMagicSticky injection", () => {
	test("injects workflow notice on goal continuation", async () => {
		const { sessionFile } = agentDirWithConfig();
		const handlers = new Map<string, Handler[]>();
		const pi = makePi(handlers);
		installGoalMagicSticky(pi);
		const ctx = makeCtx(sessionFile);

		await emit(
			handlers,
			"goal_updated",
			{
				goal: {
					id: "g1",
					objective: "研究 auth 存储路径 workflowz；交付地图",
					status: "active",
					tokensUsed: 0,
					timeUsedSeconds: 0,
					createdAt: 1,
					updatedAt: 1,
				},
				state: {
					enabled: true,
					mode: "active",
					goal: {
						id: "g1",
						objective: "研究 auth 存储路径 workflowz；交付地图",
						status: "active",
						tokensUsed: 0,
						timeUsedSeconds: 0,
						createdAt: 1,
						updatedAt: 1,
					},
				},
			},
			ctx,
		);

		const continuation = `Continue work on the active goal.

<objective>
研究 auth 存储路径 workflowz；交付地图
</objective>

Budget:
- Tokens used: 10
- Token budget: unlimited
`;

		const result = (await emit(handlers, "before_agent_start", { prompt: continuation }, ctx)) as {
			message?: { customType?: string; content?: string; display?: boolean; details?: { keywords?: string[] } };
		};

		expect(result?.message?.customType).toBe(GOAL_MAGIC_CUSTOM_TYPE);
		expect(result?.message?.display).toBe(false);
		expect(result?.message?.details?.keywords).toEqual(["workflow"]);
		expect(result?.message?.content ?? "").toContain("**workflowz**");
		expect(result?.message?.content ?? "").toContain("deterministic multi-subagent workflow");
	});

	test("skips inject when user prompt already has workflowz (stock path)", async () => {
		const { sessionFile } = agentDirWithConfig();
		const handlers = new Map<string, Handler[]>();
		installGoalMagicSticky(makePi(handlers));
		const ctx = makeCtx(sessionFile);

		await emit(
			handlers,
			"goal_updated",
			{
				goal: {
					id: "g1",
					objective: "do the research workflowz",
					status: "active",
					tokensUsed: 0,
					timeUsedSeconds: 0,
					createdAt: 1,
					updatedAt: 1,
				},
				state: {
					enabled: true,
					mode: "active",
					goal: {
						id: "g1",
						objective: "do the research workflowz",
						status: "active",
						tokensUsed: 0,
						timeUsedSeconds: 0,
						createdAt: 1,
						updatedAt: 1,
					},
				},
			},
			ctx,
		);

		const result = await emit(
			handlers,
			"before_agent_start",
			{ prompt: "do the research workflowz" },
			ctx,
		);
		expect(result).toBeUndefined();
	});

	test("injects orchestrate+workflow together on continuation", async () => {
		const { sessionFile } = agentDirWithConfig();
		const handlers = new Map<string, Handler[]>();
		installGoalMagicSticky(makePi(handlers));
		const ctx = makeCtx(sessionFile);
		const objective = "migrate payments orchestrate workflowz end to end";

		await emit(
			handlers,
			"goal_updated",
			{
				goal: { id: "g1", objective, status: "active", tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 },
				state: {
					enabled: true,
					mode: "active",
					goal: { id: "g1", objective, status: "active", tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 },
				},
			},
			ctx,
		);

		const result = (await emit(
			handlers,
			"before_agent_start",
			{
				prompt: `Continue work on the active goal.\n\n<objective>\n${objective}\n</objective>\n`,
			},
			ctx,
		)) as { message?: { details?: { keywords?: string[] }; content?: string } };

		expect(result?.message?.details?.keywords).toEqual(["orchestrate", "workflow"]);
		expect(result?.message?.content ?? "").toContain("orchestration request");
		expect(result?.message?.content ?? "").toContain("**workflowz**");
	});

	test("paused goal stops injection", async () => {
		const { sessionFile } = agentDirWithConfig();
		const handlers = new Map<string, Handler[]>();
		installGoalMagicSticky(makePi(handlers));
		const ctx = makeCtx(sessionFile);
		const objective = "keep going workflowz";

		await emit(
			handlers,
			"goal_updated",
			{
				goal: { id: "g1", objective, status: "active", tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 },
				state: {
					enabled: true,
					mode: "active",
					goal: { id: "g1", objective, status: "active", tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 },
				},
			},
			ctx,
		);

		await emit(
			handlers,
			"goal_updated",
			{
				goal: { id: "g1", objective, status: "paused", tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 2 },
				state: {
					enabled: false,
					mode: "active",
					goal: { id: "g1", objective, status: "paused", tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 2 },
				},
			},
			ctx,
		);

		const result = await emit(
			handlers,
			"before_agent_start",
			{
				prompt: `Continue work on the active goal.\n\n<objective>\n${objective}\n</objective>\n`,
			},
			ctx,
		);
		expect(result).toBeUndefined();
	});

	test("respects magicKeywords.workflow: false", async () => {
		const { sessionFile } = agentDirWithConfig(`setupVersion: 1
magicKeywords:
  enabled: true
  workflow: false
`);
		const handlers = new Map<string, Handler[]>();
		installGoalMagicSticky(makePi(handlers));
		const ctx = makeCtx(sessionFile);
		const objective = "research workflowz only";

		await emit(
			handlers,
			"goal_updated",
			{
				goal: { id: "g1", objective, status: "active", tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 },
				state: {
					enabled: true,
					mode: "active",
					goal: { id: "g1", objective, status: "active", tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1 },
				},
			},
			ctx,
		);

		const result = await emit(
			handlers,
			"before_agent_start",
			{
				prompt: `Continue work on the active goal.\n\n<objective>\n${objective}\n</objective>\n`,
			},
			ctx,
		);
		expect(result).toBeUndefined();
	});
});
