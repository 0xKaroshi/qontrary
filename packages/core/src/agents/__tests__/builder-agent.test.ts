import { describe, it, expect } from "vitest";
import { runBuilderAgent, type BuilderInput } from "../builder-agent.js";
import { E2BSandbox, type E2BSandboxLike } from "../../sandbox/e2b-runner.js";
import { CircuitBreaker } from "../../pipeline/circuit-breaker.js";
import type { AnthropicLike, SpecOutput } from "../spec-agent.js";
import type { PlanOutput } from "../planner-agent.js";

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
  tasks: [
    { id: "t1", order: 1, description: "Write hello.js", files_involved: ["hello.js"], depends_on: [], type: "implement" },
    { id: "t2", order: 2, description: "Test hello.js", files_involved: ["hello.test.js"], depends_on: ["t1"], type: "test" },
  ],
  file_tree: [
    { path: "hello.js", purpose: "main", estimated_lines: 5 },
    { path: "hello.test.js", purpose: "test", estimated_lines: 5 },
  ],
  dependencies: [],
  estimated_token_budget: 1000,
};

const input: BuilderInput = { spec, plan };

/** Build a fake sandbox whose runCommand returns the supplied exit codes in order. */
function fakeSandboxFactory(exitCodes: number[]): { sandbox: E2BSandbox; runs: string[] } {
  const runs: string[] = [];
  let i = 0;
  const fake: E2BSandboxLike = {
    files: {
      write: async () => undefined,
      read: async () => "",
      list: async () => [],
    },
    commands: {
      run: async (cmd) => {
        runs.push(cmd);
        const code = i < exitCodes.length ? exitCodes[i++]! : 0;
        return { stdout: "", stderr: code === 0 ? "" : "boom", exitCode: code };
      },
    },
    kill: async () => undefined,
  };
  const sandbox = new E2BSandbox(async () => fake);
  return { sandbox, runs };
}

/** Build a mock Anthropic client returning a constant codegen JSON. */
function mockClient(tokensPerCall = 100): AnthropicLike {
  return {
    messages: {
      create: async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              files: [{ path: "hello.js", content: "console.log('hi')" }],
              verify_command: "node hello.js",
            }),
          },
        ],
        usage: { input_tokens: tokensPerCall, output_tokens: tokensPerCall },
      }),
    },
  };
}

describe("runBuilderAgent", () => {
  it("successful build: all tasks complete and verify passes", async () => {
    const { sandbox } = fakeSandboxFactory([0, 0]);
    const out = await runBuilderAgent(input, { client: mockClient(), sandbox });
    expect(out.status).toBe("success");
    expect(out.test_results.every((t) => t.passed)).toBe(true);
    expect(out.self_fix_rounds).toBe(0);
    expect(out.files.length).toBeGreaterThan(0);
  });

  it("self-fix: a transient failure triggers a fix and then succeeds", async () => {
    const { sandbox } = fakeSandboxFactory([1, 0, 0]); // t1 fails once then ok, t2 ok
    const out = await runBuilderAgent(input, { client: mockClient(), sandbox });
    expect(out.status).toBe("success");
    expect(out.self_fix_rounds).toBeGreaterThanOrEqual(1);
  });

  it("circuit breaker: stops after 5 failed fixes on a single task", async () => {
    const { sandbox } = fakeSandboxFactory(Array(20).fill(1)); // never succeeds
    const out = await runBuilderAgent(input, { client: mockClient(), sandbox });
    expect(out.status).toBe("failed");
    expect(out.self_fix_rounds).toBe(5);
    expect(out.error_log.some((e) => e.includes("failed after 5 fix attempts"))).toBe(true);
  });

  it("cost limit: stops when $5 budget is exceeded", async () => {
    const { sandbox } = fakeSandboxFactory([0, 0]);
    // Tiny breaker so a single call trips it.
    const breaker = new CircuitBreaker({ maxCostUsd: 0.0000001, maxIterations: 100 });
    const out = await runBuilderAgent(input, { client: mockClient(10000), sandbox, breaker });
    expect(out.status).toBe("failed");
    expect(out.error_log.some((e) => e.includes("circuit breaker"))).toBe(true);
  });
});
