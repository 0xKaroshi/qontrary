import Anthropic from "@anthropic-ai/sdk";
import { CircuitBreaker, CircuitBreakerError } from "../pipeline/circuit-breaker.js";
import { E2BSandbox } from "../sandbox/e2b-runner.js";
import type { AnthropicLike, SpecOutput } from "./spec-agent.js";
import type { BuildTask, PlanOutput } from "./planner-agent.js";
import { extractJson } from "../utils/extract-json.js";

/** A critique passed back from the Contrarian when retrying a build. */
export interface ContrarianRejection {
  reasons: string[];
}

/** A single file emitted by the build. */
export interface BuiltFile {
  path: string;
  content: string;
}

/** A test result captured during the build. */
export interface TestResult {
  name: string;
  passed: boolean;
  output: string;
}

/** Builder Agent output. */
export interface BuildOutput {
  status: "success" | "failed" | "partial";
  files: BuiltFile[];
  test_results: TestResult[];
  self_fix_rounds: number;
  total_tokens_used: number;
  total_cost_usd: number;
  sandbox_id: string;
  error_log: string[];
}

/** Builder input. */
export interface BuilderInput {
  spec: SpecOutput;
  plan: PlanOutput;
  rejection?: ContrarianRejection;
}

export class BuilderAgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BuilderAgentError";
  }
}

const MODEL = "claude-sonnet-4-6";
const INPUT_PRICE = 3 / 1_000_000;
const OUTPUT_PRICE = 15 / 1_000_000;

const MAX_FIXES_PER_TASK = 5;
const MAX_API_CALLS = 30;
const MAX_COST_USD = 5;

const SYSTEM_PROMPT = `You are a senior software engineer executing a single build task.

Given a task, the surrounding plan, and any prior error output, produce the exact files that should exist on disk after this task is done. Output only what changes for THIS task.

Respond with ONLY a single JSON object — no prose, no markdown fences:
{
  "files": { "path": string, "content": string }[],
  "verify_command": string
}

verify_command is a single shell command that exits 0 when the task is correct.

CRITICAL rules for verify_command, by task type:
- task type "setup" or "config": verify_command MUST be a simple file-existence check, e.g. \`test -f src/config.ts\` (or \`test -f a && test -f b\` for multiple files). DO NOT run \`tsc\`, \`node\`, \`npm\`, or any tool that depends on dependencies being installed or other files existing.
- task type "implement": prefer a static check (\`test -f path && node --check path\` for JS, or \`test -f path\`). Only run the file if it has no external dependencies and no required env vars.
- task type "test": this is the only task type where running a test runner (\`pytest -q\`, \`vitest run\`, \`jest --silent\`) is appropriate, and only after all impl + deps are in place.
- If you genuinely cannot verify anything for this task, return "true".`;

/** Per-task code-gen response from the model. */
interface TaskCodeGen {
  files: BuiltFile[];
  verify_command: string;
}

/**
 * Extract the text block from a Claude response.
 * @param resp model response
 */
function extractText(resp: { content: { type: string; text?: string }[] }): string {
  const block = resp.content.find((c) => c.type === "text");
  if (!block || typeof block.text !== "string") {
    throw new BuilderAgentError("No text block in model response");
  }
  return block.text;
}

/**
 * Validate the per-task code-gen response.
 * @param raw parsed JSON
 */
function validateTaskCodeGen(raw: unknown): TaskCodeGen {
  if (typeof raw !== "object" || raw === null) throw new BuilderAgentError("codegen not object");
  const r = raw as Record<string, unknown>;
  if (!Array.isArray(r.files) || typeof r.verify_command !== "string") {
    throw new BuilderAgentError("codegen missing fields");
  }
  const files: BuiltFile[] = r.files.map((f, i) => {
    if (typeof f !== "object" || f === null) throw new BuilderAgentError(`files[${i}] not object`);
    const ff = f as Record<string, unknown>;
    if (typeof ff.path !== "string" || typeof ff.content !== "string") {
      throw new BuilderAgentError(`files[${i}] invalid`);
    }
    return { path: ff.path, content: ff.content };
  });
  return { files, verify_command: r.verify_command };
}

/** Options for running the Builder Agent. */
export interface RunBuilderAgentOptions {
  client?: AnthropicLike;
  sandbox?: E2BSandbox;
  breaker?: CircuitBreaker;
}

/** Internal counters tracked across the build. */
interface BuilderState {
  apiCalls: number;
  tokensUsed: number;
  costUsd: number;
  selfFixRounds: number;
  errors: string[];
}

/**
 * One Anthropic call for a single task; updates counters and breaker.
 */
async function callModelForTask(
  client: AnthropicLike,
  breaker: CircuitBreaker,
  state: BuilderState,
  systemMessage: string,
  userMessage: string,
): Promise<TaskCodeGen> {
  if (state.apiCalls >= MAX_API_CALLS) {
    throw new BuilderAgentError(`Exceeded MAX_API_CALLS (${MAX_API_CALLS})`);
  }
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 16384,
    system: systemMessage,
    messages: [{ role: "user", content: userMessage }],
  });
  state.apiCalls += 1;
  const usage = resp.usage ?? { input_tokens: 0, output_tokens: 0 };
  const cost = usage.input_tokens * INPUT_PRICE + usage.output_tokens * OUTPUT_PRICE;
  state.tokensUsed += usage.input_tokens + usage.output_tokens;
  state.costUsd += cost;
  console.log(
    `[builder] api_call=${state.apiCalls} tokens=${usage.input_tokens + usage.output_tokens} cost=$${cost.toFixed(4)}`,
  );
  breaker.record(cost);
  const text = extractText(resp);
  let parsed: unknown;
  try {
    parsed = extractJson(text);
  } catch (e) {
    throw new BuilderAgentError(
      `Model did not return valid JSON: ${(e as Error).message} | head=${text.slice(0, 120).replace(/\n/g, "\\n")}`,
    );
  }
  return validateTaskCodeGen(parsed);
}

/**
 * Build the user prompt for a task, including any prior failure context.
 */
function buildTaskPrompt(
  spec: SpecOutput,
  plan: PlanOutput,
  task: BuildTask,
  failure: { stderr: string; stdout: string } | undefined,
  rejection: ContrarianRejection | undefined,
  existingFiles: Map<string, string>,
): string {
  const lines = [
    `Title: ${spec.title}`,
    `Description: ${spec.description}`,
    `Stack: ${spec.stack.join(", ")}`,
    `Acceptance criteria (every one MUST be satisfied verbatim):\n- ${spec.acceptance_criteria.join("\n- ")}`,
    `Task: ${task.description}`,
    `Task type: ${task.type}  (remember the verify_command rules for this type)`,
    `Files involved: ${task.files_involved.join(", ")}`,
  ];
  if (rejection && rejection.reasons.length > 0) {
    lines.push(`Prior contrarian rejection reasons:\n- ${rejection.reasons.join("\n- ")}`);
  }
  if (failure) {
    lines.push(`Previous attempt failed. stderr:\n${failure.stderr}\nstdout:\n${failure.stdout}`);
    lines.push("Produce a fix.");
  }
  lines.push(`Plan file_tree paths: ${plan.file_tree.map((f) => f.path).join(", ")}`);
  if (existingFiles.size > 0) {
    lines.push(
      `\nFiles already written by earlier tasks in this build (you MUST stay consistent with their contents — do not redefine exports, change interfaces, or break tests they contain):`,
    );
    // Cap each file at 4000 chars to keep the prompt bounded; cap total context.
    let budget = 24000;
    for (const [path, content] of existingFiles) {
      const slice = content.length > 4000 ? content.slice(0, 4000) + "\n…(truncated)" : content;
      const block = `\n--- ${path} ---\n${slice}`;
      if (block.length > budget) {
        lines.push(`\n--- ${path} --- (omitted, ${content.length} chars)`);
        continue;
      }
      lines.push(block);
      budget -= block.length;
    }
  }
  return lines.join("\n");
}

/**
 * Apply a code-gen result inside the sandbox and run its verify command.
 */
async function applyAndVerify(
  sandbox: E2BSandbox,
  sandboxId: string,
  codegen: TaskCodeGen,
  collected: Map<string, string>,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  for (const f of codegen.files) {
    await sandbox.writeFile(sandboxId, f.path, f.content);
    collected.set(f.path, f.content);
  }
  const res = await sandbox.runCommand(sandboxId, codegen.verify_command);
  return { ok: res.exitCode === 0, stdout: res.stdout, stderr: res.stderr };
}

/**
 * Run the Builder Agent: scaffolds a sandbox, executes each task with a
 * self-fix loop, and returns a structured BuildOutput.
 * @param input spec + plan + optional rejection
 * @param opts injected client/sandbox/breaker (used in tests)
 */
export async function runBuilderAgent(
  input: BuilderInput,
  opts: RunBuilderAgentOptions = {},
): Promise<BuildOutput> {
  const breaker = opts.breaker ?? new CircuitBreaker({ maxCostUsd: MAX_COST_USD, maxIterations: MAX_API_CALLS });
  const client: AnthropicLike =
    opts.client ?? (new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY }) as unknown as AnthropicLike);
  const sandbox = opts.sandbox ?? new E2BSandbox();

  const state: BuilderState = { apiCalls: 0, tokensUsed: 0, costUsd: 0, selfFixRounds: 0, errors: [] };
  const collected = new Map<string, string>();
  const testResults: TestResult[] = [];

  let sandboxId = "";
  let status: BuildOutput["status"] = "success";

  try {
    sandboxId = await sandbox.createSandbox();

    if (input.plan.dependencies.length > 0) {
      const installCmd = `npm install ${input.plan.dependencies.join(" ")}`;
      const installRes = await sandbox.runCommand(sandboxId, installCmd);
      if (installRes.exitCode !== 0) {
        state.errors.push(`dep install failed: ${installRes.stderr}`);
        status = "partial";
      }
    }

    const orderedTasks = [...input.plan.tasks].sort((a, b) => a.order - b.order);

    for (const task of orderedTasks) {
      let attempt = 0;
      let lastFailure: { stdout: string; stderr: string } | undefined;
      let taskOk = false;
      let lastErrSignature = "";
      let repeatCount = 0;

      while (attempt <= MAX_FIXES_PER_TASK) {
        try {
          const codegen = await callModelForTask(
            client,
            breaker,
            state,
            SYSTEM_PROMPT,
            buildTaskPrompt(input.spec, input.plan, task, lastFailure, input.rejection, collected),
          );
          const result = await applyAndVerify(sandbox, sandboxId, codegen, collected);
          testResults.push({
            name: `${task.id}: ${task.description}`,
            passed: result.ok,
            output: result.stdout + result.stderr,
          });
          if (result.ok) {
            taskOk = true;
            break;
          }
          lastFailure = { stdout: result.stdout, stderr: result.stderr };
          state.errors.push(`task ${task.id} attempt ${attempt} failed: ${result.stderr}`);
          const sig = `verify:${result.stderr.slice(0, 200)}`;
          repeatCount = sig === lastErrSignature ? repeatCount + 1 : 0;
          lastErrSignature = sig;
          attempt += 1;
          if (attempt > 0 && attempt <= MAX_FIXES_PER_TASK) state.selfFixRounds += 1;
          if (repeatCount >= 1) {
            state.errors.push(`task ${task.id} bailed early: same error repeated`);
            break;
          }
        } catch (err) {
          if (err instanceof CircuitBreakerError) {
            state.errors.push(`circuit breaker tripped: ${err.message}`);
            status = "failed";
            return finalize(sandbox, sandboxId, status, collected, testResults, state);
          }
          state.errors.push(`task ${task.id} threw: ${String(err)}`);
          const sig = `throw:${String(err).slice(0, 200)}`;
          repeatCount = sig === lastErrSignature ? repeatCount + 1 : 0;
          lastErrSignature = sig;
          attempt += 1;
          if (attempt <= MAX_FIXES_PER_TASK) state.selfFixRounds += 1;
          if (repeatCount >= 1) {
            state.errors.push(`task ${task.id} bailed early: same error repeated`);
            break;
          }
        }
      }

      if (!taskOk) {
        state.errors.push(`task ${task.id} failed after ${MAX_FIXES_PER_TASK} fix attempts`);
        status = "failed";
        return finalize(sandbox, sandboxId, status, collected, testResults, state);
      }
    }

    return finalize(sandbox, sandboxId, status, collected, testResults, state);
  } catch (err) {
    state.errors.push(`builder threw: ${String(err)}`);
    return finalize(sandbox, sandboxId, "failed", collected, testResults, state);
  }
}

/**
 * Tear down the sandbox and assemble the final BuildOutput.
 */
async function finalize(
  sandbox: E2BSandbox,
  sandboxId: string,
  status: BuildOutput["status"],
  collected: Map<string, string>,
  testResults: TestResult[],
  state: BuilderState,
): Promise<BuildOutput> {
  if (sandboxId) {
    try {
      await sandbox.destroySandbox(sandboxId);
    } catch (err) {
      state.errors.push(`destroy failed: ${String(err)}`);
    }
  }
  return {
    status,
    files: [...collected.entries()].map(([path, content]) => ({ path, content })),
    test_results: testResults,
    self_fix_rounds: state.selfFixRounds,
    total_tokens_used: state.tokensUsed,
    total_cost_usd: state.costUsd,
    sandbox_id: sandboxId,
    error_log: state.errors,
  };
}
