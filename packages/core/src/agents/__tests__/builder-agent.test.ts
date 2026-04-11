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

const pythonSpec: SpecOutput = {
  title: "Security Scanner",
  description: "Python security audit tool",
  acceptance_criteria: ["scans for secrets"],
  stack: ["Python 3.11", "click"],
  estimated_files: 3,
  estimated_complexity: "medium",
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

const pythonPlan: PlanOutput = {
  tasks: [
    { id: "t1", order: 1, description: "Create project scaffold", files_involved: ["pyproject.toml", "scanner/__init__.py"], depends_on: [], type: "setup" },
    { id: "t2", order: 2, description: "Implement scanner", files_involved: ["scanner/main.py"], depends_on: ["t1"], type: "implement" },
    { id: "t3", order: 3, description: "Write tests", files_involved: ["tests/test_scanner.py"], depends_on: ["t2"], type: "test" },
  ],
  file_tree: [
    { path: "pyproject.toml", purpose: "manifest", estimated_lines: 15 },
    { path: "scanner/__init__.py", purpose: "init", estimated_lines: 1 },
    { path: "scanner/main.py", purpose: "scanner", estimated_lines: 100 },
    { path: "tests/test_scanner.py", purpose: "tests", estimated_lines: 50 },
  ],
  dependencies: ["click>=8.1.0"],
  estimated_token_budget: 20000,
};

const input: BuilderInput = { spec, plan };
const pythonInput: BuilderInput = { spec: pythonSpec, plan: pythonPlan };

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

/** Build a mock Anthropic client returning Python codegen JSON. */
function mockPythonClient(tokensPerCall = 100): AnthropicLike {
  return {
    messages: {
      create: async () => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              files: [{ path: "scanner/main.py", content: "import click\n" }],
              verify_command: "python3 -m pytest tests/ -q",
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

  it("circuit breaker: stops early when same error repeats (early-bail)", async () => {
    const { sandbox } = fakeSandboxFactory(Array(20).fill(1)); // never succeeds
    const out = await runBuilderAgent(input, { client: mockClient(), sandbox });
    expect(out.status).toBe("failed");
    // Early-bail triggers after 1 repeated identical error, so ≤ 5 rounds
    expect(out.self_fix_rounds).toBeGreaterThanOrEqual(1);
    expect(out.self_fix_rounds).toBeLessThanOrEqual(5);
    expect(out.error_log.length).toBeGreaterThan(0);
  });

  it("cost limit: stops when $5 budget is exceeded", async () => {
    const { sandbox } = fakeSandboxFactory([0, 0]);
    // Tiny breaker so a single call trips it.
    const breaker = new CircuitBreaker({ maxCostUsd: 0.0000001, maxIterations: 100 });
    const out = await runBuilderAgent(input, { client: mockClient(10000), sandbox, breaker });
    expect(out.status).toBe("failed");
    expect(out.error_log.some((e) => e.includes("circuit breaker"))).toBe(true);
  });

  it("Python build: uses pip for dep installation", async () => {
    const { sandbox, runs } = fakeSandboxFactory([0, 0, 0]);
    await runBuilderAgent(pythonInput, { client: mockPythonClient(), sandbox });
    const pipCmds = runs.filter((r) => r.startsWith("pip install"));
    expect(pipCmds.length).toBeGreaterThanOrEqual(1);
    // Should have a pip install that includes click (the extra dep)
    const clickInstall = pipCmds.find((r) => r.includes("click"));
    expect(clickInstall).toBeDefined();
  });

  it("Python build: uses python3 -m pytest for test verify", async () => {
    const { sandbox, runs } = fakeSandboxFactory([0, 0, 0]);
    await runBuilderAgent(pythonInput, { client: mockPythonClient(), sandbox });
    const pytestCmd = runs.find((r) => r.includes("python3 -m pytest"));
    expect(pytestCmd).toBeDefined();
  });

  it("Python build: installs pytest via pip for test tasks", async () => {
    const { sandbox, runs } = fakeSandboxFactory([0, 0, 0]);
    await runBuilderAgent(pythonInput, { client: mockPythonClient(), sandbox });
    const pipPytest = runs.find((r) => r.includes("pip install pytest"));
    expect(pipPytest).toBeDefined();
  });
});
