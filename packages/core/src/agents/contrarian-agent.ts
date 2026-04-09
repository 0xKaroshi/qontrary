import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";
import { CircuitBreaker } from "../pipeline/circuit-breaker.js";
import { extractJson } from "../utils/extract-json.js";
import type { SpecOutput, TestCase } from "./spec-agent.js";
import type { PlanOutput } from "./planner-agent.js";
import type { BuildOutput } from "./builder-agent.js";

/** Allowed reject categories. */
export type IssueCategory =
  | "SPEC_VIOLATION"
  | "EXECUTION_FAILURE"
  | "DIVERGENCE"
  | "SECURITY"
  | "BLIND_TEST_FAIL";

const ALLOWED_CATEGORIES: IssueCategory[] = [
  "SPEC_VIOLATION",
  "EXECUTION_FAILURE",
  "DIVERGENCE",
  "SECURITY",
  "BLIND_TEST_FAIL",
];

/** Single reviewer issue. */
export interface Issue {
  severity: "critical" | "major" | "minor";
  category: IssueCategory;
  description: string;
  affected_files: string[];
  suggested_fix: string;
  reported_by: ("claude" | "gpt" | "gemini")[];
}

/** Per-model verdict. */
export interface ModelVerdict {
  model: string;
  verdict: "approve" | "reject";
  issues: Issue[];
  confidence: number;
  reasoning: string;
  blind_test_results?: { test_id: string; passed: boolean }[];
  tokens_used: number;
  cost_usd: number;
}

/** Final Contrarian output. */
export interface ContrarianOutput {
  verdict: "APPROVE" | "REJECT" | "ESCALATE";
  round: number;
  issues: Issue[];
  model_verdicts: { claude?: ModelVerdict; gpt?: ModelVerdict; gemini?: ModelVerdict };
  reviewer_failures?: { name: string; error: string }[];
  consensus_score: number;
  blind_test_results: { test_id: string; passed: boolean; model_that_evaluated: string }[];
  total_tokens_used: number;
  total_cost_usd: number;
}

/** Contrarian input. */
export interface ContrarianInput {
  spec: SpecOutput;
  plan: PlanOutput;
  build: BuildOutput;
  blind_tests: TestCase[];
  round: number;
  /** Optional diff vs prior round; if absent, the entire build is reviewed. */
  diff?: string;
}

export class ContrarianAgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContrarianAgentError";
  }
}

const MAX_ROUND = 3;

// Pricing approximations (USD / token).
const PRICING = {
  claude: { input: 3 / 1_000_000, output: 15 / 1_000_000 },
  gpt: { input: 2.5 / 1_000_000, output: 10 / 1_000_000 },
  gemini: { input: 1.25 / 1_000_000, output: 5 / 1_000_000 },
} as const;

/** Reviewer focus areas. */
const FOCUS = {
  claude: "spec compliance and code quality",
  gpt: "security and edge cases",
  gemini: "divergence detection and blind test evaluation",
} as const;

const SYSTEM_PROMPT = (focus: string): string =>
  `You are a contrarian code reviewer focused on ${focus}.

Your job is to find REAL problems. You may ONLY reject for these categories:
- SPEC_VIOLATION: code does not meet an acceptance criterion
- EXECUTION_FAILURE: code crashes or tests fail
- DIVERGENCE: files or dependencies exist that were not in the plan
- SECURITY: exposed keys, SQL injection, obvious vulnerabilities
- BLIND_TEST_FAIL: code fails a blind test assertion

You MUST NOT reject for: style preferences, naming, alternative approaches, or missing features that are not in the spec.

Evaluate each blind test against the code and report pass/fail.

Respond with ONLY a single JSON object — no prose, no markdown fences:
{
  "verdict": "approve" | "reject",
  "confidence": number,
  "reasoning": string,
  "issues": {
    "severity": "critical"|"major"|"minor",
    "category": "SPEC_VIOLATION"|"EXECUTION_FAILURE"|"DIVERGENCE"|"SECURITY"|"BLIND_TEST_FAIL",
    "description": string,
    "affected_files": string[],
    "suggested_fix": string
  }[],
  "blind_test_results": { "test_id": string, "passed": boolean }[]
}`;

/**
 * Build the user prompt: spec, file-tree diff, code (or diff), tests, blind tests.
 */
function buildUserPrompt(input: ContrarianInput): string {
  const plannedPaths = new Set(input.plan.file_tree.map((f) => f.path));
  const actualPaths = new Set(input.build.files.map((f) => f.path));
  const missing = [...plannedPaths].filter((p) => !actualPaths.has(p));
  const extra = [...actualPaths].filter((p) => !plannedPaths.has(p));

  const code =
    input.round > 1 && input.diff
      ? `Diff vs previous round:\n${input.diff}`
      : input.build.files.map((f) => `--- ${f.path} ---\n${f.content}`).join("\n\n");

  return [
    `Round ${input.round}/${MAX_ROUND}`,
    `Spec title: ${input.spec.title}`,
    `Acceptance criteria:\n- ${input.spec.acceptance_criteria.join("\n- ")}`,
    `Planned files: ${[...plannedPaths].join(", ")}`,
    `Actual files: ${[...actualPaths].join(", ")}`,
    `Missing files (planned but not built): ${missing.join(", ") || "none"}`,
    `Extra files (built but not planned): ${extra.join(", ") || "none"}`,
    `Test results:\n${input.build.test_results.map((t) => `- ${t.name}: ${t.passed ? "PASS" : "FAIL"}`).join("\n")}`,
    `Blind tests to evaluate:\n${input.blind_tests.map((t) => `- ${t.id}: ${t.assertion}`).join("\n")}`,
    `Code:\n${code}`,
  ].join("\n\n");
}

/** Validate one Issue from a model response. */
function validateIssue(raw: unknown, reportedBy: "claude" | "gpt" | "gemini"): Issue | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (
    (r.severity !== "critical" && r.severity !== "major" && r.severity !== "minor") ||
    typeof r.description !== "string" ||
    typeof r.suggested_fix !== "string" ||
    !Array.isArray(r.affected_files)
  ) {
    return null;
  }
  if (typeof r.category !== "string" || !ALLOWED_CATEGORIES.includes(r.category as IssueCategory)) {
    // Style/preference rejections fail this filter and are dropped.
    return null;
  }
  return {
    severity: r.severity,
    category: r.category as IssueCategory,
    description: r.description,
    affected_files: r.affected_files.map(String),
    suggested_fix: r.suggested_fix,
    reported_by: [reportedBy],
  };
}

/** Parse a model's JSON response into a ModelVerdict. */
function parseModelResponse(
  text: string,
  modelName: "claude" | "gpt" | "gemini",
  tokensUsed: number,
  costUsd: number,
): ModelVerdict {
  let parsed: unknown;
  try {
    parsed = extractJson(text);
  } catch {
    throw new ContrarianAgentError(`${modelName} did not return JSON`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new ContrarianAgentError(`${modelName} response not object`);
  }
  const r = parsed as Record<string, unknown>;
  if (r.verdict !== "approve" && r.verdict !== "reject") {
    throw new ContrarianAgentError(`${modelName} invalid verdict`);
  }
  const rawIssues = Array.isArray(r.issues) ? r.issues : [];
  const issues = rawIssues.map((i) => validateIssue(i, modelName)).filter((i): i is Issue => i !== null);
  const blind = Array.isArray(r.blind_test_results)
    ? r.blind_test_results
        .map((b) => {
          if (typeof b !== "object" || b === null) return null;
          const bb = b as Record<string, unknown>;
          if (typeof bb.test_id !== "string" || typeof bb.passed !== "boolean") return null;
          return { test_id: bb.test_id, passed: bb.passed };
        })
        .filter((b): b is { test_id: string; passed: boolean } => b !== null)
    : [];

  // If a model rejected but had no valid (allowed-category) issues, downgrade to approve.
  let verdict: "approve" | "reject" = r.verdict;
  if (verdict === "reject" && issues.length === 0) verdict = "approve";

  return {
    model: modelName,
    verdict,
    issues,
    confidence: typeof r.confidence === "number" ? r.confidence : 0.5,
    reasoning: typeof r.reasoning === "string" ? r.reasoning : "",
    blind_test_results: blind,
    tokens_used: tokensUsed,
    cost_usd: costUsd,
  };
}

// ───────────────────── Model client interfaces ─────────────────────

export interface ClaudeLike {
  messages: {
    create: (args: {
      model: string;
      max_tokens: number;
      system: string;
      messages: { role: "user"; content: string }[];
    }) => Promise<{
      content: { type: string; text?: string }[];
      usage?: { input_tokens: number; output_tokens: number };
    }>;
  };
}

export interface GPTLike {
  chat: {
    completions: {
      create: (args: {
        model: string;
        messages: { role: "system" | "user"; content: string }[];
      }) => Promise<{
        choices: { message: { content: string | null } }[];
        usage?: { prompt_tokens: number; completion_tokens: number };
      }>;
    };
  };
}

export interface GeminiLike {
  models: {
    generateContent: (args: {
      model: string;
      contents: string;
      config?: { systemInstruction?: string };
    }) => Promise<{
      text: string;
      usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number };
    }>;
  };
}

/** Run an async fn with retry-with-backoff (3 tries, exponential: 1s, 2s, 4s). */
async function withRetry<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const delays = [1000, 2000, 4000];
  let lastErr: unknown;
  for (let attempt = 0; attempt < delays.length; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      console.log(`[contrarian] ${label} attempt ${attempt + 1} failed: ${String(err).slice(0, 120)}`);
      if (attempt < delays.length - 1) await new Promise((r) => setTimeout(r, delays[attempt]!));
    }
  }
  throw lastErr;
}

/** Reviewer call wrappers — each returns a ModelVerdict. */

async function callClaude(
  client: ClaudeLike,
  systemMsg: string,
  userMsg: string,
): Promise<ModelVerdict> {
  const resp = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 4096,
    system: systemMsg,
    messages: [{ role: "user", content: userMsg }],
  });
  const block = resp.content.find((c) => c.type === "text");
  const text = block && typeof block.text === "string" ? block.text : "";
  const usage = resp.usage ?? { input_tokens: 0, output_tokens: 0 };
  const tokens = usage.input_tokens + usage.output_tokens;
  const cost = usage.input_tokens * PRICING.claude.input + usage.output_tokens * PRICING.claude.output;
  return parseModelResponse(text, "claude", tokens, cost);
}

async function callGPT(client: GPTLike, systemMsg: string, userMsg: string): Promise<ModelVerdict> {
  const resp = await client.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: systemMsg },
      { role: "user", content: userMsg },
    ],
  });
  const text = resp.choices[0]?.message.content ?? "";
  const usage = resp.usage ?? { prompt_tokens: 0, completion_tokens: 0 };
  const tokens = usage.prompt_tokens + usage.completion_tokens;
  const cost = usage.prompt_tokens * PRICING.gpt.input + usage.completion_tokens * PRICING.gpt.output;
  return parseModelResponse(text, "gpt", tokens, cost);
}

async function callGemini(
  client: GeminiLike,
  systemMsg: string,
  userMsg: string,
): Promise<ModelVerdict> {
  const resp = await client.models.generateContent({
    model: "gemini-2.5-flash",
    contents: userMsg,
    config: { systemInstruction: systemMsg },
  });
  const usage = resp.usageMetadata ?? { promptTokenCount: 0, candidatesTokenCount: 0 };
  const tokens = usage.promptTokenCount + usage.candidatesTokenCount;
  const cost = usage.promptTokenCount * PRICING.gemini.input + usage.candidatesTokenCount * PRICING.gemini.output;
  return parseModelResponse(resp.text ?? "", "gemini", tokens, cost);
}

/** Merge issues across reviewers, deduping by category+description. */
function mergeIssues(verdicts: ModelVerdict[]): Issue[] {
  const map = new Map<string, Issue>();
  for (const v of verdicts) {
    for (const issue of v.issues) {
      const key = `${issue.category}::${issue.description}`;
      const existing = map.get(key);
      if (existing) {
        for (const r of issue.reported_by) {
          if (!existing.reported_by.includes(r)) existing.reported_by.push(r);
        }
        for (const f of issue.affected_files) {
          if (!existing.affected_files.includes(f)) existing.affected_files.push(f);
        }
      } else {
        map.set(key, { ...issue, reported_by: [...issue.reported_by], affected_files: [...issue.affected_files] });
      }
    }
  }
  return [...map.values()];
}

/** Compute consensus score: fraction of model pairs that agreed on verdict. */
function consensusScore(verdicts: ModelVerdict[]): number {
  let agreements = 0;
  let pairs = 0;
  for (let i = 0; i < verdicts.length; i++) {
    for (let j = i + 1; j < verdicts.length; j++) {
      pairs += 1;
      if (verdicts[i]!.verdict === verdicts[j]!.verdict) agreements += 1;
    }
  }
  return pairs === 0 ? 1 : agreements / pairs;
}

/** Options for runContrarianAgent — all clients are injectable for tests. */
export interface RunContrarianAgentOptions {
  claude?: ClaudeLike;
  gpt?: GPTLike;
  gemini?: GeminiLike;
  breaker?: CircuitBreaker;
}

/**
 * Run the Contrarian Agent: 3 reviewers in parallel, consensus + escalation.
 * @param input spec, plan, build, blind tests, round
 * @param opts injected clients/breaker (used in tests)
 */
export async function runContrarianAgent(
  input: ContrarianInput,
  opts: RunContrarianAgentOptions = {},
): Promise<ContrarianOutput> {
  try {
    if (input.round < 1 || input.round > MAX_ROUND) {
      throw new ContrarianAgentError(`round must be in 1..${MAX_ROUND}`);
    }
    const breaker = opts.breaker ?? new CircuitBreaker({ maxCostUsd: 5, maxIterations: 30 });
    const claude: ClaudeLike =
      opts.claude ??
      (new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) as unknown as ClaudeLike);
    const gpt: GPTLike =
      opts.gpt ?? (new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) as unknown as GPTLike);
    const gemini: GeminiLike =
      opts.gemini ??
      (new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY ?? "" }) as unknown as GeminiLike);

    const userMsg = buildUserPrompt(input);

    const settled = await Promise.allSettled([
      withRetry("claude", () => callClaude(claude, SYSTEM_PROMPT(FOCUS.claude), userMsg)),
      withRetry("gpt", () => callGPT(gpt, SYSTEM_PROMPT(FOCUS.gpt), userMsg)),
      withRetry("gemini", () => callGemini(gemini, SYSTEM_PROMPT(FOCUS.gemini), userMsg)),
    ]);
    const reviewerNames = ["claude", "gpt", "gemini"] as const;
    const failures: { name: string; error: string }[] = [];
    const ok: ModelVerdict[] = [];
    settled.forEach((s, i) => {
      if (s.status === "fulfilled") ok.push(s.value);
      else failures.push({ name: reviewerNames[i]!, error: String(s.reason) });
    });
    if (ok.length < 2) {
      throw new ContrarianAgentError(
        `Too many reviewer failures (${failures.length}/3): ${failures.map((f) => `${f.name}: ${f.error}`).join("; ")}`,
      );
    }
    if (failures.length > 0) {
      console.log(`[contrarian] degraded mode — ${failures.map((f) => f.name).join(",")} failed; using ${ok.length}/3 reviewers`);
    }
    const claudeV = ok.find((v) => v.model === "claude");
    const gptV = ok.find((v) => v.model === "gpt");
    const geminiV = ok.find((v) => v.model === "gemini");

    // Charge total cost to the breaker.
    const totalCost = ok.reduce((s, v) => s + v.cost_usd, 0);
    const totalTokens = ok.reduce((s, v) => s + v.tokens_used, 0);
    breaker.record(totalCost);

    const verdicts = ok;
    const rejectCount = verdicts.filter((v) => v.verdict === "reject").length;
    const issues = mergeIssues(verdicts);

    // Consensus: majority rule. With 3 reviewers ⇒ 2/3; with 2 reviewers (degraded) ⇒ both must reject.
    let verdict: "APPROVE" | "REJECT" | "ESCALATE";
    const rejectThreshold = verdicts.length === 2 ? 2 : 2;
    if (rejectCount >= rejectThreshold) verdict = "REJECT";
    else verdict = "APPROVE";

    // Round 3: must APPROVE or ESCALATE — never loop back to REJECT.
    if (input.round === MAX_ROUND && verdict === "REJECT") verdict = "ESCALATE";

    // Blind test aggregation: for each blind test, take the first model that evaluated it.
    const blindMap = new Map<string, { test_id: string; passed: boolean; model_that_evaluated: string }>();
    for (const v of verdicts) {
      for (const b of v.blind_test_results ?? []) {
        if (!blindMap.has(b.test_id)) {
          blindMap.set(b.test_id, { test_id: b.test_id, passed: b.passed, model_that_evaluated: v.model });
        }
      }
    }

    return {
      verdict,
      round: input.round,
      issues,
      model_verdicts: { claude: claudeV, gpt: gptV, gemini: geminiV },
      reviewer_failures: failures.length > 0 ? failures : undefined,
      consensus_score: consensusScore(verdicts),
      blind_test_results: [...blindMap.values()],
      total_tokens_used: totalTokens,
      total_cost_usd: totalCost,
    };
  } catch (err) {
    throw err instanceof ContrarianAgentError ? err : new ContrarianAgentError(String(err));
  }
}
