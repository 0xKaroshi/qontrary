import Anthropic from "@anthropic-ai/sdk";
import { CircuitBreaker } from "../pipeline/circuit-breaker.js";
import { extractJson } from "../utils/extract-json.js";

/** Input to the Spec Agent. */
export interface SpecInput {
  task: string;
  stack_preference?: string;
}

/** A blind test case the Builder never sees. */
export interface TestCase {
  id: string;
  description: string;
  type: "unit" | "integration" | "visual";
  assertion: string;
}

/** Structured spec output. */
export interface SpecOutput {
  title: string;
  description: string;
  acceptance_criteria: string[];
  stack: string[];
  estimated_files: number;
  estimated_complexity: "simple" | "medium" | "complex";
  blind_tests: TestCase[];
}

/** Minimal interface the agent needs from an Anthropic-like client. */
export interface AnthropicLike {
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

export class SpecAgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpecAgentError";
  }
}

const MODEL = "claude-sonnet-4-6";

// Pricing (USD per token) — sonnet 4.6 approx.
const INPUT_PRICE = 3 / 1_000_000;
const OUTPUT_PRICE = 15 / 1_000_000;

const SYSTEM_PROMPT = `You are a senior software architect. Your job is to convert vague feature requests into precise, testable specifications. Every acceptance criterion must be falsifiable. Also generate a set of blind test cases that will be used to verify the build WITHOUT the builder seeing them.

Be specific. Bad: "Displays token balances". Good: "Displays token symbol, amount, and USD value in a sortable HTML table".

Generate 3-5 blind tests per spec. Each blind test must have an id, description, type (unit|integration|visual), and a natural-language assertion.

Respond with ONLY a single JSON object matching this TypeScript type — no prose, no markdown fences:
{
  "title": string,
  "description": string,
  "acceptance_criteria": string[],
  "stack": string[],
  "estimated_files": number,
  "estimated_complexity": "simple" | "medium" | "complex",
  "blind_tests": { "id": string, "description": string, "type": "unit"|"integration"|"visual", "assertion": string }[]
}`;

/**
 * Build the user-facing prompt from the SpecInput.
 * @param input raw task plus optional stack preference
 */
function buildUserPrompt(input: SpecInput): string {
  const stack = input.stack_preference ? `\nPreferred stack: ${input.stack_preference}` : "";
  return `Task: ${input.task}${stack}`;
}

/**
 * Extract the JSON text from a Claude messages.create response.
 * @param resp model response
 */
function extractText(resp: { content: { type: string; text?: string }[] }): string {
  try {
    const block = resp.content.find((c) => c.type === "text");
    if (!block || typeof block.text !== "string") {
      throw new SpecAgentError("No text block in model response");
    }
    return block.text;
  } catch (err) {
    throw err instanceof SpecAgentError ? err : new SpecAgentError(String(err));
  }
}

/**
 * Validate and coerce a parsed JSON value into a SpecOutput.
 * @param raw parsed JSON
 */
function validateSpec(raw: unknown): SpecOutput {
  try {
    if (typeof raw !== "object" || raw === null) {
      throw new SpecAgentError("Spec is not an object");
    }
    const r = raw as Record<string, unknown>;
    const complexity = r.estimated_complexity;
    if (complexity !== "simple" && complexity !== "medium" && complexity !== "complex") {
      throw new SpecAgentError("Invalid estimated_complexity");
    }
    if (
      typeof r.title !== "string" ||
      typeof r.description !== "string" ||
      !Array.isArray(r.acceptance_criteria) ||
      !Array.isArray(r.stack) ||
      typeof r.estimated_files !== "number" ||
      !Array.isArray(r.blind_tests)
    ) {
      throw new SpecAgentError("Spec missing required fields");
    }
    const blind_tests: TestCase[] = r.blind_tests.map((t, i) => {
      if (typeof t !== "object" || t === null) {
        throw new SpecAgentError(`blind_tests[${i}] not an object`);
      }
      const tt = t as Record<string, unknown>;
      if (
        typeof tt.id !== "string" ||
        typeof tt.description !== "string" ||
        typeof tt.assertion !== "string" ||
        (tt.type !== "unit" && tt.type !== "integration" && tt.type !== "visual")
      ) {
        throw new SpecAgentError(`blind_tests[${i}] invalid`);
      }
      return {
        id: tt.id,
        description: tt.description,
        type: tt.type,
        assertion: tt.assertion,
      };
    });
    return {
      title: r.title,
      description: r.description,
      acceptance_criteria: r.acceptance_criteria.map(String),
      stack: r.stack.map(String),
      estimated_files: r.estimated_files,
      estimated_complexity: complexity,
      blind_tests,
    };
  } catch (err) {
    throw err instanceof SpecAgentError ? err : new SpecAgentError(String(err));
  }
}

/**
 * Strip blind_tests from a spec, returning the public-facing spec the
 * Builder is allowed to see.
 * @param spec full spec
 */
export function publicSpec(spec: SpecOutput): Omit<SpecOutput, "blind_tests"> {
  const { blind_tests: _omit, ...rest } = spec;
  void _omit;
  return rest;
}

/** Options for running the Spec Agent. */
export interface RunSpecAgentOptions {
  client?: AnthropicLike;
  breaker?: CircuitBreaker;
}

/**
 * Run the Spec Agent: one Anthropic call, returns a validated SpecOutput.
 * @param input raw task
 * @param opts optional injected client/breaker (used in tests)
 */
export async function runSpecAgent(
  input: SpecInput,
  opts: RunSpecAgentOptions = {},
): Promise<SpecOutput> {
  try {
    const breaker = opts.breaker ?? new CircuitBreaker({ maxCostUsd: 1, maxIterations: 1 });
    const client: AnthropicLike =
      opts.client ?? (new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) as unknown as AnthropicLike);

    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildUserPrompt(input) }],
    });

    const usage = resp.usage ?? { input_tokens: 0, output_tokens: 0 };
    const cost = usage.input_tokens * INPUT_PRICE + usage.output_tokens * OUTPUT_PRICE;
    breaker.record(cost);

    const text = extractText(resp);
    let parsed: unknown;
    try {
      parsed = extractJson(text);
    } catch {
      throw new SpecAgentError("Model did not return valid JSON");
    }
    return validateSpec(parsed);
  } catch (err) {
    throw err instanceof SpecAgentError ? err : new SpecAgentError(String(err));
  }
}
