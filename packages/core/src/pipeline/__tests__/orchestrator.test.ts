import { describe, it, expect } from "vitest";
import { Orchestrator, OrchestratorError, type AgentRunners } from "../orchestrator.js";
import type { SpecOutput } from "../../agents/spec-agent.js";
import type { PlanOutput } from "../../agents/planner-agent.js";
import type { BuildOutput } from "../../agents/builder-agent.js";
import type { ContrarianOutput } from "../../agents/contrarian-agent.js";

const spec: SpecOutput = {
  title: "Hello",
  description: "demo",
  acceptance_criteria: ["prints hello"],
  stack: ["node"],
  estimated_files: 1,
  estimated_complexity: "simple",
  blind_tests: [],
};

const plan: PlanOutput = {
  tasks: [{ id: "t1", order: 1, description: "Write hello.js", files_involved: ["hello.js"], depends_on: [], type: "implement" }],
  file_tree: [{ path: "hello.js", purpose: "main", estimated_lines: 5 }],
  dependencies: [],
  estimated_token_budget: 1000,
};

function makeBuild(cost = 0.1): BuildOutput {
  return {
    status: "success",
    files: [{ path: "hello.js", content: "console.log('hi')" }],
    test_results: [{ name: "t1", passed: true, output: "" }],
    self_fix_rounds: 0,
    total_tokens_used: 100,
    total_cost_usd: cost,
    sandbox_id: "sbx_1",
    error_log: [],
  };
}

function makeReview(verdict: ContrarianOutput["verdict"], cost = 0.05): ContrarianOutput {
  return {
    verdict,
    round: 1,
    issues:
      verdict === "REJECT"
        ? [
            {
              severity: "critical",
              category: "SPEC_VIOLATION",
              description: "missing hello",
              affected_files: ["hello.js"],
              suggested_fix: "print hello",
              reported_by: ["claude", "gpt"],
            },
          ]
        : [],
    model_verdicts: {
      claude: { model: "claude", verdict: verdict === "APPROVE" ? "approve" : "reject", issues: [], confidence: 1, reasoning: "", tokens_used: 0, cost_usd: 0 },
      gpt: { model: "gpt", verdict: verdict === "APPROVE" ? "approve" : "reject", issues: [], confidence: 1, reasoning: "", tokens_used: 0, cost_usd: 0 },
      gemini: { model: "gemini", verdict: verdict === "APPROVE" ? "approve" : "reject", issues: [], confidence: 1, reasoning: "", tokens_used: 0, cost_usd: 0 },
    },
    consensus_score: 1,
    blind_test_results: [],
    total_tokens_used: 0,
    total_cost_usd: cost,
  };
}

function runners(reviews: ContrarianOutput["verdict"][]): AgentRunners {
  let i = 0;
  return {
    spec: async () => spec,
    planner: async () => plan,
    builder: async () => makeBuild(),
    contrarian: async () => makeReview(reviews[i++] ?? "APPROVE"),
  };
}

describe("Orchestrator", () => {
  it("happy path: spec → plan → build → approve in 1 round", async () => {
    const orch = new Orchestrator({ runners: runners(["APPROVE"]) });
    const result = await orch.run("Build hello world");
    expect(result.status).toBe("APPROVED");
    expect(result.total_rounds).toBe(1);
    expect(result.files.length).toBe(1);
    expect(result.total_cost_usd).toBeCloseTo(0.15, 5);
  });

  it("rejection loop: reject then approve in 2 rounds", async () => {
    const orch = new Orchestrator({ runners: runners(["REJECT", "APPROVE"]) });
    const result = await orch.run("Build hello world");
    expect(result.status).toBe("APPROVED");
    expect(result.total_rounds).toBe(2);
  });

  it("escalation: 3 rejections → ESCALATED", async () => {
    const orch = new Orchestrator({ runners: runners(["REJECT", "REJECT", "REJECT"]) });
    const result = await orch.run("Build hello world");
    expect(result.status).toBe("ESCALATED");
    expect(result.total_rounds).toBe(3);
  });

  it("cost limit: stops when total exceeds $10", async () => {
    const expensive: AgentRunners = {
      spec: async () => spec,
      planner: async () => plan,
      builder: async () => makeBuild(20),
      contrarian: async () => makeReview("APPROVE"),
    };
    const orch = new Orchestrator({ runners: expensive, maxCostUsd: 10 });
    await expect(orch.run("Build hello world")).rejects.toBeInstanceOf(OrchestratorError);
    expect(orch.stateMachine.state).toBe("FAILED");
  });

  it("state transitions are all legal (no illegal jumps)", async () => {
    const orch = new Orchestrator({ runners: runners(["REJECT", "APPROVE"]) });
    const seen: string[] = [];
    orch.on("build:state_changed", (e: { from: string; to: string }) => seen.push(`${e.from}->${e.to}`));
    await orch.run("Build hello world");
    // Sanity: every transition we observed must be one the state machine accepted.
    const transitions = orch.stateMachine.transitions;
    expect(transitions.length).toBe(seen.length);
    expect(transitions.every((t) => t.from !== t.to)).toBe(true);
    // Final state must be APPROVED.
    expect(orch.stateMachine.state).toBe("APPROVED");
    // Pipeline must include the expected high-level steps in order.
    const path = transitions.map((t) => t.to);
    expect(path[0]).toBe("SPECCING");
    expect(path[1]).toBe("PLANNING");
    expect(path).toContain("BUILDING");
    expect(path).toContain("REVIEWING");
    expect(path[path.length - 1]).toBe("APPROVED");
  });
});
