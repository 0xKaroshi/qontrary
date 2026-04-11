import { describe, it, expect } from "vitest";
import { runPlannerAgent, PlannerAgentError, type PlanOutput } from "../planner-agent.js";
import type { AnthropicLike, SpecOutput } from "../spec-agent.js";

const spec: SpecOutput = {
  title: "Token Scanner",
  description: "Scan Solana wallets and alert on price moves.",
  acceptance_criteria: ["Displays token symbol, amount, and USD value in a sortable HTML table"],
  stack: ["Next.js", "Tailwind"],
  estimated_files: 6,
  estimated_complexity: "medium",
  blind_tests: [],
};

const pythonSpec: SpecOutput = {
  title: "Security Audit Tool",
  description: "Python security audit tool that scans a directory for vulnerabilities",
  acceptance_criteria: ["Scans for secrets", "Produces JSON report"],
  stack: ["Python 3.11", "click", "jinja2"],
  estimated_files: 10,
  estimated_complexity: "complex",
  blind_tests: [],
};

const validPlan: PlanOutput = {
  tasks: [
    { id: "t1", order: 1, description: "Scaffold Next.js app", files_involved: ["package.json"], depends_on: [], type: "setup" },
    { id: "t2", order: 2, description: "Implement scanner page", files_involved: ["app/page.tsx"], depends_on: ["t1"], type: "implement" },
    { id: "t3", order: 3, description: "Test scanner page", files_involved: ["app/page.test.tsx"], depends_on: ["t2"], type: "test" },
  ],
  file_tree: [
    { path: "package.json", purpose: "Project manifest", estimated_lines: 20 },
    { path: "app/page.tsx", purpose: "Main scanner page", estimated_lines: 120 },
    { path: "app/page.test.tsx", purpose: "Tests for scanner page", estimated_lines: 60 },
  ],
  dependencies: ["next", "react", "tailwindcss", "@solana/web3.js"],
  estimated_token_budget: 30000,
};

const validPythonPlan: PlanOutput = {
  tasks: [
    { id: "t1", order: 1, description: "Scaffold project with pyproject.toml", files_involved: ["pyproject.toml", "secaudit/__init__.py"], depends_on: [], type: "setup" },
    { id: "t2", order: 2, description: "Implement all scanner modules", files_involved: ["secaudit/scanners.py", "secaudit/cli.py"], depends_on: ["t1"], type: "implement" },
    { id: "t3", order: 3, description: "Implement report generation", files_involved: ["secaudit/report.py"], depends_on: ["t2"], type: "implement" },
    { id: "t4", order: 4, description: "Write tests", files_involved: ["tests/test_scanners.py"], depends_on: ["t3"], type: "test" },
  ],
  file_tree: [
    { path: "pyproject.toml", purpose: "Project manifest", estimated_lines: 20 },
    { path: "secaudit/__init__.py", purpose: "Package init", estimated_lines: 1 },
    { path: "secaudit/scanners.py", purpose: "Scanner modules", estimated_lines: 200 },
    { path: "secaudit/cli.py", purpose: "CLI entry point", estimated_lines: 50 },
    { path: "secaudit/report.py", purpose: "Report generation", estimated_lines: 100 },
    { path: "tests/test_scanners.py", purpose: "Tests", estimated_lines: 150 },
  ],
  dependencies: ["click>=8.1.0", "jinja2>=3.1.0", "pytest>=8.0"],
  estimated_token_budget: 40000,
};

function mockClient(payload: unknown): AnthropicLike {
  return {
    messages: {
      create: async () => ({
        content: [{ type: "text", text: JSON.stringify(payload) }],
        usage: { input_tokens: 200, output_tokens: 400 },
      }),
    },
  };
}

describe("runPlannerAgent", () => {
  it("returns tasks in valid dependency order", async () => {
    const out = await runPlannerAgent(spec, { client: mockClient(validPlan) });
    const seen = new Set<string>();
    for (const t of [...out.tasks].sort((a, b) => a.order - b.order)) {
      for (const dep of t.depends_on) {
        expect(seen.has(dep)).toBe(true);
      }
      seen.add(t.id);
    }
  });

  it("every file in tasks.files_involved exists in file_tree", async () => {
    const out = await runPlannerAgent(spec, { client: mockClient(validPlan) });
    const treePaths = new Set(out.file_tree.map((n) => n.path));
    for (const t of out.tasks) {
      for (const f of t.files_involved) {
        expect(treePaths.has(f)).toBe(true);
      }
    }
  });

  it("rejects hallucinated/invalid package names", async () => {
    const bad: PlanOutput = { ...validPlan, dependencies: ["next", "Definitely Not A Real Package!!"] };
    await expect(runPlannerAgent(spec, { client: mockClient(bad) })).rejects.toBeInstanceOf(PlannerAgentError);
  });

  it("accepts pip-style version specifiers in dependencies", async () => {
    const out = await runPlannerAgent(pythonSpec, { client: mockClient(validPythonPlan) });
    expect(out.dependencies).toContain("click>=8.1.0");
    expect(out.dependencies).toContain("jinja2>=3.1.0");
    expect(out.dependencies).toContain("pytest>=8.0");
  });

  it("Python plan has ≤7 tasks", async () => {
    const out = await runPlannerAgent(pythonSpec, { client: mockClient(validPythonPlan) });
    expect(out.tasks.length).toBeLessThanOrEqual(7);
  });
});
