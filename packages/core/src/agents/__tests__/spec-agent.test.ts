import { describe, it, expect } from "vitest";
import {
  runSpecAgent,
  publicSpec,
  type AnthropicLike,
  type SpecOutput,
} from "../spec-agent.js";

const validSpec: SpecOutput = {
  title: "Solana Token Scanner",
  description: "A web app that scans Solana wallets and alerts on price moves.",
  acceptance_criteria: [
    "Displays token symbol, amount, and USD value in a sortable HTML table",
    "Sends an email alert when any token price moves more than 5% in 1 hour",
    "Refreshes balances every 30 seconds without a full page reload",
  ],
  stack: ["Next.js", "Tailwind", "Solana web3.js"],
  estimated_files: 12,
  estimated_complexity: "medium",
  blind_tests: [
    { id: "bt1", description: "Table sorts by USD value desc", type: "unit", assertion: "Clicking USD header sorts rows descending" },
    { id: "bt2", description: "Alert fires on 6% move", type: "integration", assertion: "Mock price feed +6% triggers email send" },
    { id: "bt3", description: "Renders empty state", type: "visual", assertion: "Empty wallet shows 'No tokens found'" },
  ],
};

function mockClient(spec: SpecOutput): AnthropicLike {
  return {
    messages: {
      create: async () => ({
        content: [{ type: "text", text: JSON.stringify(spec) }],
        usage: { input_tokens: 100, output_tokens: 200 },
      }),
    },
  };
}

describe("runSpecAgent", () => {
  it("returns a valid spec with all required fields for a simple task", async () => {
    const client = mockClient(validSpec);
    const out = await runSpecAgent({ task: "Build a Solana token scanner" }, { client });
    expect(out.title).toBe(validSpec.title);
    expect(out.description.length).toBeGreaterThan(0);
    expect(out.acceptance_criteria.length).toBeGreaterThanOrEqual(1);
    expect(out.stack.length).toBeGreaterThan(0);
    expect(typeof out.estimated_files).toBe("number");
    expect(["simple", "medium", "complex"]).toContain(out.estimated_complexity);
    expect(out.blind_tests.length).toBeGreaterThanOrEqual(3);
  });

  it("acceptance criteria are specific, not vague", async () => {
    const client = mockClient(validSpec);
    const out = await runSpecAgent({ task: "Build a Solana token scanner" }, { client });
    const vague = /^(displays|shows|handles|supports|works)\s+\w+\.?$/i;
    for (const ac of out.acceptance_criteria) {
      expect(ac.length).toBeGreaterThan(20);
      expect(ac).not.toMatch(vague);
    }
  });

  it("blind tests do not leak when spec is shared via publicSpec", async () => {
    const client = mockClient(validSpec);
    const out = await runSpecAgent({ task: "Build a Solana token scanner" }, { client });
    expect(out.blind_tests.length).toBeGreaterThan(0);
    const pub = publicSpec(out);
    expect("blind_tests" in pub).toBe(false);
    expect(JSON.stringify(pub)).not.toContain("bt1");
  });
});
