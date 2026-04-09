import Anthropic from "@anthropic-ai/sdk";
import { CircuitBreaker } from "../pipeline/circuit-breaker.js";
import { extractJson } from "../utils/extract-json.js";
import type { SpecOutput, AnthropicLike } from "./spec-agent.js";

/** A single ordered build task. */
export interface BuildTask {
  id: string;
  order: number;
  description: string;
  files_involved: string[];
  depends_on: string[];
  type: "setup" | "implement" | "test" | "config";
}

/** A node in the canonical file tree. */
export interface FileNode {
  path: string;
  purpose: string;
  estimated_lines: number;
}

/** Planner Agent output. */
export interface PlanOutput {
  tasks: BuildTask[];
  file_tree: FileNode[];
  dependencies: string[];
  estimated_token_budget: number;
}

export class PlannerAgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlannerAgentError";
  }
}

const MODEL = "claude-sonnet-4-6";
const INPUT_PRICE = 3 / 1_000_000;
const OUTPUT_PRICE = 15 / 1_000_000;

const SYSTEM_PROMPT = `You are a senior software architect creating a build plan for a coding agent.

Given a spec, output the CANONICAL file tree and an ordered task list. The file tree you produce is the source of truth — later stages will compare actual build output against it to detect drift.

Rules:
- Every path mentioned in any task's files_involved MUST appear in file_tree.
- Tasks must be in valid dependency order: a task's depends_on must reference earlier task ids.
- Use only real, well-known npm packages — no invented names. Prefer popular, currently-maintained packages.
- Task types: "setup" (scaffolding/install), "implement" (feature code), "test" (tests), "config" (config files).

Respond with ONLY a single JSON object — no prose, no markdown fences:
{
  "tasks": { "id": string, "order": number, "description": string, "files_involved": string[], "depends_on": string[], "type": "setup"|"implement"|"test"|"config" }[],
  "file_tree": { "path": string, "purpose": string, "estimated_lines": number }[],
  "dependencies": string[],
  "estimated_token_budget": number
}`;

/**
 * Build the user prompt for the Planner from a SpecOutput.
 * The full spec (without blind_tests) is included.
 * @param spec spec output
 */
function buildUserPrompt(spec: SpecOutput): string {
  const { blind_tests: _omit, ...pub } = spec;
  void _omit;
  return `Spec:\n${JSON.stringify(pub, null, 2)}`;
}

/**
 * Extract text from a Claude messages.create response.
 * @param resp model response
 */
function extractText(resp: { content: { type: string; text?: string }[] }): string {
  const block = resp.content.find((c) => c.type === "text");
  if (!block || typeof block.text !== "string") {
    throw new PlannerAgentError("No text block in model response");
  }
  return block.text;
}

// npm package name validation (https://github.com/npm/validate-npm-package-name simplified)
const NPM_NAME = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;

/**
 * Validate that a string looks like a real npm package name.
 * @param name candidate package name
 */
function isValidNpmName(name: string): boolean {
  if (typeof name !== "string" || name.length === 0) return false;
  const at = name.lastIndexOf("@");
  const bare = at > 0 ? name.slice(0, at) : name;
  return bare.length > 0 && bare.length <= 214 && NPM_NAME.test(bare);
}

/**
 * Validate that tasks form a valid dependency order.
 * @param tasks task list
 */
function validateOrdering(tasks: BuildTask[]): void {
  const seen = new Set<string>();
  const sorted = [...tasks].sort((a, b) => a.order - b.order);
  for (const t of sorted) {
    for (const dep of t.depends_on) {
      if (!seen.has(dep)) {
        throw new PlannerAgentError(`Task ${t.id} depends on ${dep} which has not yet been declared`);
      }
    }
    seen.add(t.id);
  }
}

/**
 * Validate and coerce a parsed JSON value into a PlanOutput.
 * @param raw parsed JSON
 */
function validatePlan(raw: unknown): PlanOutput {
  try {
    if (typeof raw !== "object" || raw === null) {
      throw new PlannerAgentError("Plan is not an object");
    }
    const r = raw as Record<string, unknown>;
    if (
      !Array.isArray(r.tasks) ||
      !Array.isArray(r.file_tree) ||
      !Array.isArray(r.dependencies) ||
      typeof r.estimated_token_budget !== "number"
    ) {
      throw new PlannerAgentError("Plan missing required fields");
    }

    const file_tree: FileNode[] = r.file_tree.map((n, i) => {
      if (typeof n !== "object" || n === null) throw new PlannerAgentError(`file_tree[${i}] not object`);
      const nn = n as Record<string, unknown>;
      if (
        typeof nn.path !== "string" ||
        typeof nn.purpose !== "string" ||
        typeof nn.estimated_lines !== "number"
      ) {
        throw new PlannerAgentError(`file_tree[${i}] invalid`);
      }
      return { path: nn.path, purpose: nn.purpose, estimated_lines: nn.estimated_lines };
    });

    const tasks: BuildTask[] = r.tasks.map((t, i) => {
      if (typeof t !== "object" || t === null) throw new PlannerAgentError(`tasks[${i}] not object`);
      const tt = t as Record<string, unknown>;
      if (
        typeof tt.id !== "string" ||
        typeof tt.order !== "number" ||
        typeof tt.description !== "string" ||
        !Array.isArray(tt.files_involved) ||
        !Array.isArray(tt.depends_on) ||
        (tt.type !== "setup" && tt.type !== "implement" && tt.type !== "test" && tt.type !== "config")
      ) {
        throw new PlannerAgentError(`tasks[${i}] invalid`);
      }
      return {
        id: tt.id,
        order: tt.order,
        description: tt.description,
        files_involved: tt.files_involved.map(String),
        depends_on: tt.depends_on.map(String),
        type: tt.type,
      };
    });

    const dependencies: string[] = r.dependencies.map(String);
    for (const dep of dependencies) {
      if (!isValidNpmName(dep)) {
        throw new PlannerAgentError(`Invalid npm package name: ${dep}`);
      }
    }

    // Cross-validation: every file referenced in tasks must exist in file_tree
    const treePaths = new Set(file_tree.map((n) => n.path));
    for (const t of tasks) {
      for (const f of t.files_involved) {
        if (!treePaths.has(f)) {
          throw new PlannerAgentError(`Task ${t.id} references file not in file_tree: ${f}`);
        }
      }
    }

    validateOrdering(tasks);

    return {
      tasks,
      file_tree,
      dependencies,
      estimated_token_budget: r.estimated_token_budget,
    };
  } catch (err) {
    throw err instanceof PlannerAgentError ? err : new PlannerAgentError(String(err));
  }
}

/** Options for running the Planner Agent. */
export interface RunPlannerAgentOptions {
  client?: AnthropicLike;
  breaker?: CircuitBreaker;
}

/**
 * Run the Planner Agent: one Anthropic call, returns a validated PlanOutput.
 * @param spec validated spec from the Spec Agent
 * @param opts optional injected client/breaker
 */
export async function runPlannerAgent(
  spec: SpecOutput,
  opts: RunPlannerAgentOptions = {},
): Promise<PlanOutput> {
  try {
    const breaker = opts.breaker ?? new CircuitBreaker({ maxCostUsd: 1, maxIterations: 1 });
    const client: AnthropicLike =
      opts.client ?? (new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) as unknown as AnthropicLike);

    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserPrompt(spec) }],
    });

    const usage = resp.usage ?? { input_tokens: 0, output_tokens: 0 };
    const cost = usage.input_tokens * INPUT_PRICE + usage.output_tokens * OUTPUT_PRICE;
    breaker.record(cost);

    const text = extractText(resp);
    let parsed: unknown;
    try {
      parsed = extractJson(text);
    } catch {
      throw new PlannerAgentError("Model did not return valid JSON");
    }
    return validatePlan(parsed);
  } catch (err) {
    throw err instanceof PlannerAgentError ? err : new PlannerAgentError(String(err));
  }
}
