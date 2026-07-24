import { describe, expect, test } from "bun:test";
import {
	__testContainsKeyword,
	isGoalContinuationPrompt,
	stockWouldInject,
} from "./goal-magic-sticky.ts";

const settingsOn = {
	enabled: true,
	ultrathink: true,
	orchestrate: true,
	workflow: true,
	taskBatch: true,
};

describe("containsKeyword", () => {
	test("matches standalone lowercase words", () => {
		expect(__testContainsKeyword("research with workflowz please", "workflow")).toBe(true);
		expect(__testContainsKeyword("please orchestrate this", "orchestrate")).toBe(true);
		expect(__testContainsKeyword("ultrathink carefully", "ultrathink")).toBe(true);
	});

	test("rejects glued / capitalized forms", () => {
		expect(__testContainsKeyword("workflowzed", "workflow")).toBe(false);
		expect(__testContainsKeyword("Orchestrate", "orchestrate")).toBe(false);
		expect(__testContainsKeyword("path/workflowz.ts", "workflow")).toBe(false);
	});
});

describe("isGoalContinuationPrompt", () => {
	test("matches stock continuation shape", () => {
		const prompt = `Continue work on the active goal.

<objective>
研究 auth workflowz
</objective>

Budget:
- Tokens used: 1
`;
		expect(isGoalContinuationPrompt(prompt)).toBe(true);
	});

	test("rejects ordinary user prompts even with objective tags", () => {
		expect(isGoalContinuationPrompt("please workflowz this")).toBe(false);
		expect(isGoalContinuationPrompt("<objective>x</objective>")).toBe(false);
	});
});

describe("stockWouldInject", () => {
	test("continuation never counts as stock inject", () => {
		expect(
			stockWouldInject("workflow", "Continue work on the active goal.\n<objective>workflowz</objective>", {
				continuation: true,
				settings: settingsOn,
				hasTaskTool: true,
			}),
		).toBe(false);
	});

	test("user prompt with keyword does", () => {
		expect(
			stockWouldInject("workflow", "please workflowz the research", {
				continuation: false,
				settings: settingsOn,
				hasTaskTool: true,
			}),
		).toBe(true);
	});

	test("workflow without task tool does not", () => {
		expect(
			stockWouldInject("workflow", "please workflowz the research", {
				continuation: false,
				settings: settingsOn,
				hasTaskTool: false,
			}),
		).toBe(false);
	});

	test("respects per-keyword disable", () => {
		expect(
			stockWouldInject("orchestrate", "please orchestrate this", {
				continuation: false,
				settings: { ...settingsOn, orchestrate: false },
				hasTaskTool: true,
			}),
		).toBe(false);
	});
});
