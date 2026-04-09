/** Build lifecycle states. */
export type BuildState =
  | "CREATED"
  | "SPECCING"
  | "SPEC_REVIEW"
  | "PLANNING"
  | "BUILDING"
  | "REVIEWING"
  | "APPROVED"
  | "REJECTED"
  | "ESCALATED"
  | "FAILED"
  | "CANCELLED";

const TRANSITIONS: Record<BuildState, BuildState[]> = {
  CREATED: ["SPECCING", "CANCELLED", "FAILED"],
  SPECCING: ["SPEC_REVIEW", "PLANNING", "FAILED", "CANCELLED"],
  SPEC_REVIEW: ["PLANNING", "CANCELLED", "FAILED"],
  PLANNING: ["BUILDING", "FAILED", "CANCELLED"],
  BUILDING: ["REVIEWING", "FAILED", "CANCELLED"],
  REVIEWING: ["APPROVED", "REJECTED", "ESCALATED", "BUILDING", "FAILED", "CANCELLED"],
  APPROVED: [],
  REJECTED: [],
  ESCALATED: [],
  FAILED: [],
  CANCELLED: [],
};

/** A single state transition with timestamp and (optional) cost so far. */
export interface StateTransition {
  from: BuildState;
  to: BuildState;
  at: number;
  cost_usd: number;
}

export class StateMachineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StateMachineError";
  }
}

/** Build state machine: enforces legal transitions and records history. */
export class StateMachine {
  private current: BuildState = "CREATED";
  private readonly history: StateTransition[] = [];

  /** Current state. */
  get state(): BuildState {
    return this.current;
  }

  /** Full transition history (in order). */
  get transitions(): readonly StateTransition[] {
    return this.history;
  }

  /**
   * Transition to a new state, throwing on illegal moves.
   * @param next target state
   * @param cost_usd current cumulative cost
   */
  transition(next: BuildState, cost_usd = 0): StateTransition {
    try {
      const allowed = TRANSITIONS[this.current];
      if (!allowed.includes(next)) {
        throw new StateMachineError(`Invalid transition: ${this.current} -> ${next}`);
      }
      const t: StateTransition = { from: this.current, to: next, at: Date.now(), cost_usd };
      this.current = next;
      this.history.push(t);
      return t;
    } catch (err) {
      throw err instanceof StateMachineError ? err : new StateMachineError(String(err));
    }
  }

  /** Whether a transition is legal from the current state. */
  canTransition(next: BuildState): boolean {
    return TRANSITIONS[this.current].includes(next);
  }
}
