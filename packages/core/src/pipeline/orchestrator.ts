import { EventEmitter } from "node:events";
import { runSpecAgent, type SpecInput, type SpecOutput } from "../agents/spec-agent.js";
import { runPlannerAgent, type PlanOutput } from "../agents/planner-agent.js";
import {
  runBuilderAgent,
  type BuildOutput,
  type BuilderInput,
  type ContrarianRejection,
} from "../agents/builder-agent.js";
import {
  runContrarianAgent,
  type ContrarianInput,
  type ContrarianOutput,
} from "../agents/contrarian-agent.js";
import { StateMachine, type BuildState } from "./state-machine.js";

/** Final orchestrator result. */
export interface OrchestratorResult {
  build_id: string;
  status: BuildState;
  spec: SpecOutput;
  plan: PlanOutput;
  final_build: BuildOutput;
  contrarian_reviews: ContrarianOutput[];
  total_rounds: number;
  total_cost_usd: number;
  total_time_ms: number;
  files: { path: string; content: string }[];
}

/** Injected agent runners — production wires the real ones, tests inject fakes. */
export interface AgentRunners {
  spec: (input: SpecInput) => Promise<SpecOutput>;
  planner: (spec: SpecOutput) => Promise<PlanOutput>;
  builder: (input: BuilderInput) => Promise<BuildOutput>;
  contrarian: (input: ContrarianInput) => Promise<ContrarianOutput>;
}

/** Options for the Orchestrator. */
export interface OrchestratorOptions {
  runners?: Partial<AgentRunners>;
  maxCostUsd?: number;
  maxRounds?: number;
  buildId?: string;
}

export class OrchestratorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrchestratorError";
  }
}

const DEFAULT_MAX_COST = 10;
const DEFAULT_MAX_ROUNDS = 3;

/**
 * Orchestrator — drives Spec → Plan → Build → Contrarian loop, emitting events.
 *
 * Events:
 *  - build:state_changed { buildId, from, to, timestamp }
 *  - agent:started { buildId, agent, round }
 *  - agent:completed { buildId, agent, output_summary }
 *  - agent:error { buildId, agent, error }
 *  - build:cost_update { buildId, total_cost_usd }
 *  - build:completed { buildId, verdict, total_cost, total_time }
 */
export class Orchestrator extends EventEmitter {
  private readonly runners: AgentRunners;
  private readonly maxCostUsd: number;
  private readonly maxRounds: number;
  private readonly buildId: string;
  private readonly state: StateMachine;
  private totalCostUsd = 0;
  private startTime = 0;
  private lastSpec?: SpecOutput;
  private lastPlan?: PlanOutput;
  private lastBuild?: BuildOutput;
  private lastReviews: ContrarianOutput[] = [];

  constructor(opts: OrchestratorOptions = {}) {
    super();
    this.runners = {
      spec: opts.runners?.spec ?? ((input) => runSpecAgent(input)),
      planner: opts.runners?.planner ?? ((spec) => runPlannerAgent(spec)),
      builder: opts.runners?.builder ?? ((input) => runBuilderAgent(input)),
      contrarian: opts.runners?.contrarian ?? ((input) => runContrarianAgent(input)),
    };
    this.maxCostUsd = opts.maxCostUsd ?? DEFAULT_MAX_COST;
    this.maxRounds = opts.maxRounds ?? DEFAULT_MAX_ROUNDS;
    this.buildId = opts.buildId ?? `build_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.state = new StateMachine();
  }

  /** Current state machine — exposed for tests. */
  get stateMachine(): StateMachine {
    return this.state;
  }

  /** Build id (stable across the run). */
  get id(): string {
    return this.buildId;
  }

  /**
   * Snapshot of whatever the orchestrator has produced so far. Useful when
   * `run()` throws and the caller still wants to persist partial artifacts
   * (spec, plan, last build, error log) for debugging.
   */
  partialResult(): Partial<OrchestratorResult> & { build_id: string; status: BuildState } {
    return {
      build_id: this.buildId,
      status: this.state.state,
      spec: this.lastSpec,
      plan: this.lastPlan,
      final_build: this.lastBuild,
      contrarian_reviews: this.lastReviews,
      total_rounds: this.lastReviews.length,
      total_cost_usd: this.totalCostUsd,
      total_time_ms: this.startTime ? Date.now() - this.startTime : 0,
      files: this.lastBuild?.files.map((f) => ({ path: f.path, content: f.content })) ?? [],
    };
  }

  /** Move state, charge cost, emit event. */
  private moveTo(next: BuildState): void {
    const t = this.state.transition(next, this.totalCostUsd);
    this.emit("build:state_changed", {
      buildId: this.buildId,
      from: t.from,
      to: t.to,
      timestamp: t.at,
    });
  }

  /** Add cost; throw if hard cap exceeded. */
  private addCost(delta: number): void {
    this.totalCostUsd += delta;
    this.emit("build:cost_update", { buildId: this.buildId, total_cost_usd: this.totalCostUsd });
    if (this.totalCostUsd > this.maxCostUsd) {
      throw new OrchestratorError(
        `Cost limit exceeded: $${this.totalCostUsd.toFixed(4)} > $${this.maxCostUsd}`,
      );
    }
  }

  /**
   * Run the full pipeline.
   * @param task raw user task
   * @param stack_preference optional preferred stack
   */
  async run(task: string, stack_preference?: string): Promise<OrchestratorResult> {
    this.startTime = Date.now();
    let spec: SpecOutput | undefined;
    let plan: PlanOutput | undefined;
    let build: BuildOutput | undefined;
    const reviews: ContrarianOutput[] = [];
    this.lastReviews = reviews;

    try {
      this.moveTo("SPECCING");
      spec = await this.callAgent("spec", 0, () => this.runners.spec({ task, stack_preference }));
      this.lastSpec = spec;

      this.moveTo("PLANNING");
      plan = await this.callAgent("planner", 0, () => this.runners.planner(spec!));
      this.lastPlan = plan;

      let round = 1;
      let rejection: ContrarianRejection | undefined;
      let verdict: ContrarianOutput["verdict"] = "REJECT";

      while (round <= this.maxRounds) {
        this.moveTo("BUILDING");
        build = await this.callAgent("builder", round, () =>
          this.runners.builder({ spec: spec!, plan: plan!, rejection }),
        );
        this.lastBuild = build;
        this.addCost(build.total_cost_usd);

        if (build.status === "failed") {
          this.moveTo("FAILED");
          throw new OrchestratorError(
            `Builder failed: ${build.error_log[build.error_log.length - 1] ?? "unknown error"}`,
          );
        }

        this.moveTo("REVIEWING");
        const review = await this.callAgent("contrarian", round, () =>
          this.runners.contrarian({
            spec: spec!,
            plan: plan!,
            build: build!,
            blind_tests: spec!.blind_tests,
            round,
          }),
        );
        this.addCost(review.total_cost_usd);
        reviews.push(review);
        verdict = review.verdict;

        if (verdict === "APPROVE") {
          this.moveTo("APPROVED");
          break;
        }
        if (verdict === "ESCALATE") {
          this.moveTo("ESCALATED");
          break;
        }
        // REJECT
        if (round >= this.maxRounds) {
          this.moveTo("ESCALATED");
          verdict = "ESCALATE";
          break;
        }
        rejection = { reasons: review.issues.map((i) => `${i.category}: ${i.description}`) };
        round += 1;
      }

      const result: OrchestratorResult = {
        build_id: this.buildId,
        status: this.state.state,
        spec: spec!,
        plan: plan!,
        final_build: build!,
        contrarian_reviews: reviews,
        total_rounds: reviews.length,
        total_cost_usd: this.totalCostUsd,
        total_time_ms: Date.now() - this.startTime,
        files: build!.files.map((f) => ({ path: f.path, content: f.content })),
      };

      this.emit("build:completed", {
        buildId: this.buildId,
        verdict: result.status,
        total_cost: result.total_cost_usd,
        total_time: result.total_time_ms,
      });

      return result;
    } catch (err) {
      if (this.state.canTransition("FAILED")) this.moveTo("FAILED");
      this.emit("agent:error", { buildId: this.buildId, agent: "orchestrator", error: String(err) });
      this.emit("build:completed", {
        buildId: this.buildId,
        verdict: this.state.state,
        total_cost: this.totalCostUsd,
        total_time: Date.now() - this.startTime,
      });
      throw err instanceof OrchestratorError ? err : new OrchestratorError(String(err));
    }
  }

  /** Wrap an agent call with started/completed/error events. */
  private async callAgent<T>(agent: string, round: number, fn: () => Promise<T>): Promise<T> {
    this.emit("agent:started", { buildId: this.buildId, agent, round });
    try {
      const out = await fn();
      this.emit("agent:completed", {
        buildId: this.buildId,
        agent,
        output_summary: summarize(out),
      });
      return out;
    } catch (err) {
      this.emit("agent:error", { buildId: this.buildId, agent, error: String(err) });
      throw err;
    }
  }
}

/** Compact summary string for an agent output (for events). */
function summarize(out: unknown): string {
  if (typeof out !== "object" || out === null) return String(out);
  const r = out as Record<string, unknown>;
  if (typeof r.title === "string") return `spec: ${r.title}`;
  if (Array.isArray(r.tasks)) return `plan: ${r.tasks.length} tasks`;
  if (typeof r.status === "string" && Array.isArray(r.files)) {
    return `build: ${r.status}, ${r.files.length} files`;
  }
  if (typeof r.verdict === "string") return `review: ${r.verdict}`;
  return "ok";
}
