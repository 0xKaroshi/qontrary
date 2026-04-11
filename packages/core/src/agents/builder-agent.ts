import Anthropic from "@anthropic-ai/sdk";
import { CircuitBreaker, CircuitBreakerError } from "../pipeline/circuit-breaker.js";
import { E2BSandbox } from "../sandbox/e2b-runner.js";
import type { AnthropicLike, SpecOutput } from "./spec-agent.js";
import type { BuildTask, PlanOutput } from "./planner-agent.js";
import { extractJson } from "../utils/extract-json.js";
import { generateMocks, renderMockInstructions } from "../utils/mock-generator.js";
import { matchTemplate, getPreInstalledPackages, isPythonProject, TEMPLATES } from "../sandbox/templates.js";

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
  /** Base64-encoded PNG screenshot of the running UI, if applicable. */
  screenshot?: string;
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

const SYSTEM_PROMPT_NODE = `You are a senior software engineer executing a single build task.

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
- task type "test": this is the only task type where running a test runner is appropriate. ALWAYS prefix with \`npx\` (e.g. \`npx vitest run --reporter=verbose\`, \`npx jest --forceExit\`, \`npx pytest -q\`). NEVER use bare \`jest\`, \`vitest\`, or \`pytest\` — the binary may not be on PATH.
- If you genuinely cannot verify anything for this task, return "true".

CRITICAL: All test files MUST mock external HTTP calls. Tests must NEVER make real network requests.
Override global fetch or use jest.mock/vi.mock to intercept HTTP. If mock data is provided in the prompt, use those exact response shapes.
Tests that require a running server (Express/WebSocket) MUST use supertest or start/stop the server in setup/teardown — never rely on a pre-running server process.

Common dependencies may be pre-installed in the sandbox. Do not generate setup tasks that only run \`npm install\` for packages that are already present. If a setup task's only purpose is installing dependencies, use a simple file-existence check as verify_command.`;

const SYSTEM_PROMPT_PYTHON = `You are a senior software engineer executing a single build task for a Python project.

Given a task, the surrounding plan, and any prior error output, produce the exact files that should exist on disk after this task is done. Output only what changes for THIS task.

Respond with ONLY a single JSON object — no prose, no markdown fences:
{
  "files": { "path": string, "content": string }[],
  "verify_command": string
}

verify_command is a single shell command that exits 0 when the task is correct.

CRITICAL rules for verify_command, by task type:
- task type "setup" or "config": verify_command MUST be a simple file-existence check, e.g. \`test -f pyproject.toml\` (or \`test -f a && test -f b\` for multiple files). DO NOT run \`python3\`, \`pip\`, or any tool that depends on other files existing.
- task type "implement": prefer \`python3 -c "import module_name"\` to verify the module is syntactically valid and importable. For scripts, use \`python3 -c "compile(open('path').read(), 'path', 'exec')"\`. Only import the module if all its dependencies are available.
- task type "test": use \`python3 -m pytest tests/ -q\` or \`python3 -m pytest path/to/test_file.py -q\`. NEVER use bare \`pytest\` — use \`python3 -m pytest\` to ensure correct Python path.
- If you genuinely cannot verify anything for this task, return "true".

CRITICAL: All test files MUST mock external calls using unittest.mock.patch or pytest monkeypatch.
Tests must NEVER make real network requests or run real subprocesses.

CRITICAL: This is a Python project. Do NOT use npm, node, npx, vitest, jest, or any Node.js tools.
Use pip for package installation, python3 for execution, and python3 -m pytest for testing.

Common dependencies may be pre-installed in the sandbox (pytest, pytest-cov). Do not reinstall them.

LEARNED RULES (from prior adversarial review — follow strictly):
- Always use CONSISTENT function names across all modules. If a function is called check_docker_security in the main module, use the exact same name everywhere (imports, tests, CLI). Never have check_docker_compose in one file and check_docker_security in another.
- Always handle missing users/directories gracefully with try/except. Never assume /etc/crontab or /etc/ssh/sshd_config exists.
- Always propagate exit codes correctly: sys.exit(main()) in __main__.py. Return non-zero exit code if any CRITICAL (exit 2) or HIGH (exit 1) findings exist.
- For security audit tools: always check docker-compose.yml AND docker-compose.yaml. Also detect services with no "user" field (defaults to root — flag as HIGH).
- Keep test files SHORT — max 200 lines per test file. Test only the public API, not internal helpers. Use parametrize for similar test cases.`;

/**
 * Select the appropriate system prompt based on project runtime.
 * @param isPython whether the project targets Python
 */
function getSystemPrompt(isPython: boolean): string {
  return isPython ? SYSTEM_PROMPT_PYTHON : SYSTEM_PROMPT_NODE;
}

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

/** Max output tokens by runtime. Python files embedded in JSON need more space. */
const MAX_TOKENS_NODE = 16384;
// 21000 is the practical ceiling without SDK streaming (~30% more than Node).
// SDK throws "streaming required" above ~21333 tokens.
const MAX_TOKENS_PYTHON = 21000;

/**
 * One Anthropic call for a single task; updates counters and breaker.
 */
async function callModelForTask(
  client: AnthropicLike,
  breaker: CircuitBreaker,
  state: BuilderState,
  systemMessage: string,
  userMessage: string,
  maxTokens: number = MAX_TOKENS_NODE,
): Promise<TaskCodeGen> {
  if (state.apiCalls >= MAX_API_CALLS) {
    throw new BuilderAgentError(`Exceeded MAX_API_CALLS (${MAX_API_CALLS})`);
  }
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
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
    // Model returned prose or malformed JSON — retry with stronger nudge
    console.log(`[builder] extractJson failed — retrying with stronger nudge (has braces: ${text.includes("{")})`);
    if (state.apiCalls >= MAX_API_CALLS) {
      throw new BuilderAgentError(`Exceeded MAX_API_CALLS (${MAX_API_CALLS})`);
    }
    const retryResp = await client.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      system: systemMessage,
      messages: [
        { role: "user" as const, content: userMessage },
        { role: "user" as const, content: `Your previous response was not valid JSON. It started with:\n"${text.slice(0, 200)}…"\n\nYou MUST respond with ONLY the JSON object — no explanation, no thinking, no markdown, no prose before or after. Start your response with the opening brace. Just {"files": [...], "verify_command": "..."}` },
      ],
    });
    state.apiCalls += 1;
    const retryUsage = retryResp.usage ?? { input_tokens: 0, output_tokens: 0 };
    const retryCost = retryUsage.input_tokens * INPUT_PRICE + retryUsage.output_tokens * OUTPUT_PRICE;
    state.tokensUsed += retryUsage.input_tokens + retryUsage.output_tokens;
    state.costUsd += retryCost;
    breaker.record(retryCost);
    const retryText = extractText(retryResp);
    try {
      parsed = extractJson(retryText);
    } catch (e2) {
      throw new BuilderAgentError(
        `Model did not return valid JSON after retry: ${(e2 as Error).message} | head=${retryText.slice(0, 120).replace(/\n/g, "\\n")}`,
      );
    }
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
  python?: boolean,
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
  if (task.type === "test") {
    const mocks = generateMocks(spec);
    const mockBlock = renderMockInstructions(mocks);
    if (mockBlock) {
      lines.push(mockBlock);
    } else {
      lines.push(
        "\nNETWORK MOCKING (MANDATORY): All test files MUST mock external HTTP calls.",
        "Override global fetch or use jest.mock/vi.mock. NEVER make real network requests from tests.",
        "Generate realistic mock fixtures inline for any external endpoints the code under test calls.",
      );
    }
  }
  if (existingFiles.size > 0) {
    lines.push(
      `\nFiles already written by earlier tasks in this build (you MUST stay consistent with their contents — do not redefine exports, change interfaces, or break tests they contain):`,
    );
    // Cap each file at 4000 chars (6000 for Python) to keep the prompt bounded; cap total context.
    const perFileCap = python ? 6000 : 4000;
    let budget = python ? 48000 : 24000;
    for (const [path, content] of existingFiles) {
      const slice = content.length > perFileCap ? content.slice(0, perFileCap) + "\n…(truncated)" : content;
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
 * For Python projects, verify that all local imports in generated files
 * resolve against files already written. If a `from X import Y` references
 * a name that doesn't exist in module X, rewrite the import to use the
 * correct name found in that module's source.
 *
 * Mutates codegen.files in-place.
 */
function fixPythonImports(codegen: TaskCodeGen, collected: Map<string, string>): string[] {
  const fixes: string[] = [];

  // Build a map of module path → set of top-level names (def/class/variable assignments)
  const moduleExports = new Map<string, Set<string>>();
  for (const [path, content] of collected) {
    if (!path.endsWith(".py")) continue;
    const names = new Set<string>();
    for (const line of content.split("\n")) {
      // Match: def func_name(, class ClassName(, VARIABLE =
      const defMatch = line.match(/^(?:def|async\s+def)\s+([a-zA-Z_]\w*)\s*\(/);
      if (defMatch) { names.add(defMatch[1]); continue; }
      const classMatch = line.match(/^class\s+([a-zA-Z_]\w*)\s*[:(]/);
      if (classMatch) { names.add(classMatch[1]); continue; }
      const varMatch = line.match(/^([A-Z_][A-Z0-9_]*)\s*=/);
      if (varMatch) { names.add(varMatch[1]); continue; }
      // Also catch regular variable assignments at top level (no indent)
      const assignMatch = line.match(/^([a-zA-Z_]\w*)\s*(?::\s*\w+\s*)?=/);
      if (assignMatch && !line.startsWith(" ") && !line.startsWith("\t")) {
        names.add(assignMatch[1]);
      }
    }
    moduleExports.set(path, names);
  }

  // Also index files from this codegen (they may import each other)
  for (const f of codegen.files) {
    if (!f.path.endsWith(".py")) continue;
    if (moduleExports.has(f.path)) continue;
    const names = new Set<string>();
    for (const line of f.content.split("\n")) {
      const defMatch = line.match(/^(?:def|async\s+def)\s+([a-zA-Z_]\w*)\s*\(/);
      if (defMatch) { names.add(defMatch[1]); continue; }
      const classMatch = line.match(/^class\s+([a-zA-Z_]\w*)\s*[:(]/);
      if (classMatch) { names.add(classMatch[1]); continue; }
      const varMatch = line.match(/^([A-Z_][A-Z0-9_]*)\s*=/);
      if (varMatch) { names.add(varMatch[1]); }
    }
    moduleExports.set(f.path, names);
  }

  // Convert module dotted paths to file paths: "audit_lib.models" → "audit_lib/models.py"
  function moduleToPath(mod: string): string | undefined {
    const asPath = mod.replace(/\./g, "/") + ".py";
    if (moduleExports.has(asPath)) return asPath;
    // Try __init__.py
    const initPath = mod.replace(/\./g, "/") + "/__init__.py";
    if (moduleExports.has(initPath)) return initPath;
    return undefined;
  }

  for (const f of codegen.files) {
    if (!f.path.endsWith(".py")) continue;
    const lines = f.content.split("\n");
    let changed = false;

    for (let i = 0; i < lines.length; i++) {
      // Match: from module.path import name1, name2, ...
      const importMatch = lines[i].match(/^from\s+([\w.]+)\s+import\s+(.+)$/);
      if (!importMatch) continue;

      const modPath = moduleToPath(importMatch[1]);
      if (!modPath) continue; // stdlib or external — skip

      const exports = moduleExports.get(modPath);
      if (!exports || exports.size === 0) continue;

      const importedNames = importMatch[2].split(",").map((n) => n.trim().split(/\s+as\s+/)[0].trim());
      const fixedNames: string[] = [];

      for (const name of importedNames) {
        if (exports.has(name)) {
          fixedNames.push(name);
          continue;
        }
        // Name doesn't exist — find closest match
        const lower = name.toLowerCase();
        let bestMatch: string | null = null;
        for (const exp of exports) {
          if (exp.toLowerCase() === lower) { bestMatch = exp; break; }
          // Fuzzy: if the export contains the import name or vice versa
          if (exp.toLowerCase().includes(lower) || lower.includes(exp.toLowerCase())) {
            bestMatch = exp;
          }
        }
        if (bestMatch) {
          fixes.push(`import fix: ${f.path}: ${name} → ${bestMatch} (from ${modPath})`);
          fixedNames.push(bestMatch);
          changed = true;
        } else {
          // Can't find a match — keep original, will fail at verify and self-fix
          fixes.push(`import warning: ${f.path}: ${name} not found in ${modPath} (exports: ${[...exports].join(", ")})`);
          fixedNames.push(name);
        }
      }

      if (changed) {
        lines[i] = `from ${importMatch[1]} import ${fixedNames.join(", ")}`;
      }
    }

    if (changed) {
      f.content = lines.join("\n");
    }
  }

  return fixes;
}

/**
 * Apply a code-gen result inside the sandbox and run its verify command.
 */
async function applyAndVerify(
  sandbox: E2BSandbox,
  sandboxId: string,
  codegen: TaskCodeGen,
  collected: Map<string, string>,
  taskType?: string,
  python?: boolean,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  // For Python projects, verify and fix imports before writing files
  if (python) {
    const importFixes = fixPythonImports(codegen, collected);
    for (const fix of importFixes) {
      console.log(`[builder] ${fix}`);
    }
  }

  for (const f of codegen.files) {
    await sandbox.writeFile(sandboxId, f.path, f.content);
    collected.set(f.path, f.content);
  }
  if (taskType === "test") {
    const runner = detectTestRunner(codegen.verify_command, python);
    if (runner) {
      console.log(`[builder] ensuring test runner "${runner}" is installed`);
      const installCmd = python
        ? `pip install ${runner} 2>/dev/null || true`
        : `npm install --save-dev ${runner} 2>/dev/null || true`;
      await sandbox.runCommand(sandboxId, installCmd);
    }
  }
  const res = await sandbox.runCommand(sandboxId, codegen.verify_command);
  return { ok: res.exitCode === 0, stdout: res.stdout, stderr: res.stderr };
}

/**
 * Detect which test runner a verify command references.
 * @param cmd verify command string
 * @param python whether this is a Python project
 */
function detectTestRunner(cmd: string, python?: boolean): string | null {
  if (python) {
    if (/\bpytest\b/.test(cmd)) return "pytest";
    return null;
  }
  if (/\bvitest\b/.test(cmd)) return "vitest";
  if (/\bjest\b/.test(cmd)) return "jest";
  if (/\bmocha\b/.test(cmd)) return "mocha";
  return null;
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
    // Match spec to a warm template and create a pre-provisioned sandbox
    const templateName = matchTemplate(input.spec.description, input.spec.stack);
    const preInstalled = getPreInstalledPackages(templateName);
    const python = TEMPLATES[templateName]?.runtime === "python";
    const systemPrompt = getSystemPrompt(python);
    console.log(`[builder] matched template: ${templateName} (runtime: ${python ? "python" : "node"})`);
    sandboxId = await sandbox.createWarmSandbox(templateName);

    // Only install deps that aren't already in the template
    const extraDeps = input.plan.dependencies.filter((d) => {
      // Strip version specifiers: npm (@scope/pkg@1.0 → @scope/pkg) and pip (click>=8.0 → click)
      const bare = d.replace(/[@>=<~!][^/].*$/, "");
      return !preInstalled.has(bare);
    });
    if (extraDeps.length > 0) {
      console.log(`[builder] installing ${extraDeps.length} extra deps (${preInstalled.size} pre-installed)`);
      const installCmd = python
        ? `pip install ${extraDeps.join(" ")} 2>&1`
        : `npm install ${extraDeps.join(" ")}`;
      const installRes = await sandbox.runCommand(sandboxId, installCmd);
      if (installRes.exitCode !== 0) {
        state.errors.push(`dep install failed: ${installRes.stderr}`);
        status = "partial";
      }
    } else if (input.plan.dependencies.length > 0) {
      console.log(`[builder] all ${input.plan.dependencies.length} deps pre-installed by template`);
    }

    const orderedTasks = [...input.plan.tasks].sort((a, b) => a.order - b.order);

    // Identify setup tasks that only install pre-installed deps (can be skipped)
    const skippableTasks = new Set<string>();
    for (const task of orderedTasks) {
      if (task.type === "setup" && isDepOnlySetup(task, preInstalled)) {
        skippableTasks.add(task.id);
      }
    }

    for (const task of orderedTasks) {
      // Skip setup tasks whose only job is installing pre-installed packages
      if (skippableTasks.has(task.id)) {
        console.log(`[builder] skipping redundant setup task ${task.id}: deps pre-installed`);
        testResults.push({
          name: `${task.id}: ${task.description}`,
          passed: true,
          output: "skipped — dependencies pre-installed by warm sandbox",
        });
        continue;
      }

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
            systemPrompt,
            buildTaskPrompt(input.spec, input.plan, task, lastFailure, input.rejection, collected, python),
            python ? MAX_TOKENS_PYTHON : MAX_TOKENS_NODE,
          );
          const result = await applyAndVerify(sandbox, sandboxId, codegen, collected, task.type, python);
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
            return finalize(sandbox, sandboxId, status, collected, testResults, state, input.spec);
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
        return finalize(sandbox, sandboxId, status, collected, testResults, state, input.spec);
      }
    }

    return finalize(sandbox, sandboxId, status, collected, testResults, state, input.spec);
  } catch (err) {
    state.errors.push(`builder threw: ${String(err)}`);
    return finalize(sandbox, sandboxId, "failed", collected, testResults, state, input.spec);
  }
}

/**
 * Check if a setup task's only purpose is installing dependencies that
 * are already pre-installed by the warm sandbox template.
 * @param task a build task
 * @param preInstalled set of pre-installed package names
 */
function isDepOnlySetup(task: BuildTask, preInstalled: Set<string>): boolean {
  if (preInstalled.size === 0) return false;
  const desc = task.description.toLowerCase();
  // Match tasks like "Install dependencies", "Set up project dependencies", "npm/pip install"
  const isInstallTask = /\b(install|set\s*up)\b.*\b(dep|package|module|node_module)\b/i.test(desc)
    || /\b(npm|pip)\s+install\b/i.test(desc)
    || /\binitiali[sz]e\s+(project|package)\b/i.test(desc);
  if (!isInstallTask) return false;
  // If the task involves creating config files, don't skip it
  const hasConfigFiles = task.files_involved.some((f) =>
    /\.(json|ts|js|yml|yaml|toml)$/i.test(f) && !/package\.json$/i.test(f) && !/pyproject\.toml$/i.test(f),
  );
  return !hasConfigFiles;
}

/** UI keyword patterns in the stack. */
const UI_KEYWORDS = /\b(react|vue|svelte|angular|html|css|frontend|ui|nextjs|next\.js|remix|astro|vite)\b/i;

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
  spec?: SpecOutput,
): Promise<BuildOutput> {
  let screenshot: string | undefined;

  // Attempt screenshot for UI builds before destroying sandbox
  if (sandboxId && status !== "failed" && spec) {
    const haystack = [spec.description, ...spec.stack].join(" ");
    if (UI_KEYWORDS.test(haystack)) {
      try {
        // Start a dev server in the background
        await sandbox.runCommand(
          sandboxId,
          "(npx serve -s build -l 3000 2>/dev/null || npx vite preview --port 3000 2>/dev/null || npx serve -l 3000 2>/dev/null || npm start &) &",
        );
        await sandbox.runCommand(sandboxId, "sleep 3");
        const result = await sandbox.takeScreenshot(sandboxId, "http://localhost:3000");
        screenshot = result.base64Png;
        console.log(`[builder] screenshot captured for ${sandboxId}`);
      } catch (err) {
        console.log(`[builder] screenshot failed (non-fatal): ${String(err).slice(0, 120)}`);
      }
    }
  }

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
    screenshot,
  };
}
