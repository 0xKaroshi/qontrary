import { describe, it, expect } from "vitest";
import {
  runContrarianAgent,
  type ClaudeLike,
  type GPTLike,
  type GeminiLike,
  type ContrarianInput,
} from "../contrarian-agent.js";
import type { SpecOutput, TestCase } from "../spec-agent.js";
import type { PlanOutput } from "../planner-agent.js";
import type { BuildOutput } from "../builder-agent.js";

const blind_tests: TestCase[] = [
  { id: "bt1", description: "prints hello", type: "unit", assertion: "stdout contains hello" },
];

const spec: SpecOutput = {
  title: "Hello",
  description: "demo",
  acceptance_criteria: ["prints hello"],
  stack: ["node"],
  estimated_files: 1,
  estimated_complexity: "simple",
  blind_tests,
};

const plan: PlanOutput = {
  tasks: [{ id: "t1", order: 1, description: "Write hello.js", files_involved: ["hello.js"], depends_on: [], type: "implement" }],
  file_tree: [{ path: "hello.js", purpose: "main", estimated_lines: 5 }],
  dependencies: [],
  estimated_token_budget: 1000,
};

const build: BuildOutput = {
  status: "success",
  files: [{ path: "hello.js", content: "console.log('hello')" }],
  test_results: [{ name: "t1", passed: true, output: "" }],
  self_fix_rounds: 0,
  total_tokens_used: 100,
  total_cost_usd: 0.01,
  sandbox_id: "sbx_1",
  error_log: [],
};

const baseInput: ContrarianInput = { spec, plan, build, blind_tests, round: 1 };

interface ModelResp {
  verdict: "approve" | "reject";
  confidence?: number;
  reasoning?: string;
  issues?: unknown[];
  blind_test_results?: { test_id: string; passed: boolean }[];
}

function claudeMock(resp: ModelResp, tokens = { i: 100, o: 100 }): ClaudeLike {
  return {
    messages: {
      create: async () => ({
        content: [{ type: "text", text: JSON.stringify(resp) }],
        usage: { input_tokens: tokens.i, output_tokens: tokens.o },
      }),
    },
  };
}

function gptMock(resp: ModelResp, tokens = { p: 100, c: 100 }): GPTLike {
  return {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: JSON.stringify(resp) } }],
          usage: { prompt_tokens: tokens.p, completion_tokens: tokens.c },
        }),
      },
    },
  };
}

function geminiMock(resp: ModelResp, tokens = { p: 100, c: 100 }): GeminiLike {
  return {
    models: {
      generateContent: async () => ({
        text: JSON.stringify(resp),
        usageMetadata: { promptTokenCount: tokens.p, candidatesTokenCount: tokens.c },
      }),
    },
  };
}

const approve: ModelResp = {
  verdict: "approve",
  confidence: 0.9,
  reasoning: "ok",
  issues: [],
  blind_test_results: [{ test_id: "bt1", passed: true }],
};

const rejectSpec: ModelResp = {
  verdict: "reject",
  confidence: 0.9,
  reasoning: "missing acceptance",
  issues: [
    {
      severity: "critical",
      category: "SPEC_VIOLATION",
      description: "does not print hello",
      affected_files: ["hello.js"],
      suggested_fix: "print hello",
    },
  ],
  blind_test_results: [{ test_id: "bt1", passed: false }],
};

const rejectStyle: ModelResp = {
  verdict: "reject",
  confidence: 0.9,
  reasoning: "I prefer let",
  issues: [
    {
      severity: "minor",
      category: "STYLE", // not in allowed list — must be filtered out
      description: "use let instead of const",
      affected_files: ["hello.js"],
      suggested_fix: "rewrite",
    },
  ],
};

describe("runContrarianAgent", () => {
  it("all 3 approve → APPROVE", async () => {
    const out = await runContrarianAgent(baseInput, {
      claude: claudeMock(approve),
      gpt: gptMock(approve),
      gemini: geminiMock(approve),
    });
    expect(out.verdict).toBe("APPROVE");
    expect(out.consensus_score).toBe(1);
    expect(out.issues.length).toBe(0);
  });

  it("2/3 reject → REJECT with merged issues", async () => {
    const out = await runContrarianAgent(baseInput, {
      claude: claudeMock(rejectSpec),
      gpt: gptMock(rejectSpec),
      gemini: geminiMock(approve),
    });
    expect(out.verdict).toBe("REJECT");
    expect(out.issues.length).toBe(1);
    expect(out.issues[0]!.reported_by.sort()).toEqual(["claude", "gpt"]);
  });

  it("round 3 with unresolved issues → ESCALATE", async () => {
    const out = await runContrarianAgent(
      { ...baseInput, round: 3 },
      {
        claude: claudeMock(rejectSpec),
        gpt: gptMock(rejectSpec),
        gemini: geminiMock(rejectSpec),
      },
    );
    expect(out.verdict).toBe("ESCALATE");
  });

  it("style-only rejections are filtered out and downgraded to APPROVE", async () => {
    const out = await runContrarianAgent(baseInput, {
      claude: claudeMock(rejectStyle),
      gpt: gptMock(rejectStyle),
      gemini: geminiMock(approve),
    });
    expect(out.verdict).toBe("APPROVE");
    expect(out.issues.length).toBe(0);
    expect(out.model_verdicts.claude!.verdict).toBe("approve");
    expect(out.model_verdicts.gpt!.verdict).toBe("approve");
  });

  it("blind test failures are correctly reported", async () => {
    const out = await runContrarianAgent(baseInput, {
      claude: claudeMock(rejectSpec),
      gpt: gptMock(approve),
      gemini: geminiMock(approve),
    });
    expect(out.blind_test_results.length).toBe(1);
    const bt = out.blind_test_results.find((b) => b.test_id === "bt1");
    expect(bt).toBeDefined();
    expect(["claude", "gpt", "gemini"]).toContain(bt!.model_that_evaluated);
  });

  it("cost tracking sums all 3 parallel calls", async () => {
    const out = await runContrarianAgent(baseInput, {
      claude: claudeMock(approve, { i: 1000, o: 1000 }),
      gpt: gptMock(approve, { p: 1000, c: 1000 }),
      gemini: geminiMock(approve, { p: 1000, c: 1000 }),
    });
    expect(out.total_tokens_used).toBe(6000);
    // Claude 1000*3e-6 + 1000*15e-6 = 0.018
    // GPT    1000*2.5e-6 + 1000*10e-6 = 0.0125
    // Gemini 1000*1.25e-6 + 1000*5e-6 = 0.00625
    // Total ≈ 0.03675
    expect(out.total_cost_usd).toBeCloseTo(0.03675, 5);
    expect(out.model_verdicts.claude!.cost_usd).toBeGreaterThan(0);
    expect(out.model_verdicts.gpt!.cost_usd).toBeGreaterThan(0);
    expect(out.model_verdicts.gemini!.cost_usd).toBeGreaterThan(0);
  });
});
