/**
 * Circuit breaker — enforces cost and loop limits on model calls.
 */
export interface CircuitBreakerOptions {
  maxCostUsd: number;
  maxIterations: number;
}

export class CircuitBreakerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CircuitBreakerError";
  }
}

export class CircuitBreaker {
  private costUsd = 0;
  private iterations = 0;

  constructor(private readonly opts: CircuitBreakerOptions) {}

  /**
   * Record a model call's cost and increment loop counter.
   * @param costUsd marginal cost in USD
   */
  record(costUsd: number): void {
    this.costUsd += costUsd;
    this.iterations += 1;
    if (this.costUsd > this.opts.maxCostUsd) {
      throw new CircuitBreakerError(`Cost limit exceeded: ${this.costUsd}`);
    }
    if (this.iterations > this.opts.maxIterations) {
      throw new CircuitBreakerError(`Iteration limit exceeded: ${this.iterations}`);
    }
  }

  /** Current totals. */
  stats(): { costUsd: number; iterations: number } {
    return { costUsd: this.costUsd, iterations: this.iterations };
  }
}
