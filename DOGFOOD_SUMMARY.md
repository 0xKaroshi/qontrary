# Qontrary Dogfood Summary

18 end-to-end builds across two days (2026-04-09 → 2026-04-10), iterating on the framework as bugs surfaced.

## 1. Results table

| # | Task | Verdict | Rounds | Time | Cost | What the Contrarian caught |
|---|---|---|---|---|---|---|
| 1 | Bitcoin price fetcher (CoinGecko) | ✅ APPROVED | 1 | 287s | $0.42 | Nothing |
| 2 | Express `/health` endpoint | ✅ APPROVED | 1 | 104s | $0.07 | Nothing |
| 3 | Telegram `/price` bot | ⚠️ APPROVED *(false positive — build status was `failed`)* | 1 | 399s | $0.47 | Nothing — rubber-stamped a broken build |
| 4 | Telegram `/price` bot (re-run after Orchestrator guard) | ✅ APPROVED | 1 | 290s | $0.27 | Nothing |
| 5 | CSV summary script (1st) | ❌ FAILED (`setup-project` verify) | — | ~90s | ~$0.12 | Never reached reviewer (orch fail-fast) |
| 6 | React sortable crypto table (1st) | ❌ FAILED (Builder JSON parse) | — | ~280s | ~$0.39 | Never reached reviewer |
| 7a | CSV summary script (re-run) | ✅ APPROVED | 3 | 725s | $1.13 | **Real spec violation:** `First 3 Rows: (none)` printed on two lines instead of one for header-only CSVs. Builder fixed it round 3. |
| 7b | React table (re-run) | ❌ FAILED (test/impl drift round 2) | 2 | 432s | $0.57 | Caught real issues round 1, but Builder regressed against its own tests on round 2 |
| 8 | React table (after file-context fix) | ❌ FAILED (E2B timeout + JSON prose) | — | ~390s | ~$0.61 | Never reached reviewer |
| 9 | Cron uptime monitor (1st) | ❌ FAILED (`implement-config` verify) | — | 128s | $0.06 | Never reached reviewer |
| 10 | Cron uptime monitor (after verify-rules) | ❌ FAILED (`implement-status-evaluator`) | — | 184s | $0.17 | Never reached reviewer |
| 11 | Solana CLI (Helius API) | ❌ FAILED (`test-integration` + sandbox aged out) | — | 465s | $0.73 | Never reached reviewer |
| 12 | Express todo API (1st) | ❌ FAILED (`test-03`) | — | 345s | $0.54 | Never reached reviewer |
| 13 | DexScreener scraper | ❌ FAILED (malformed model JSON, early-bail) | — | 65s | $0.03 | Never reached reviewer |
| 14 | WebSocket broadcaster | ❌ FAILED (`implement-server` verify too aggressive) | — | 67s | $0.05 | Never reached reviewer |
| 15 | Cron uptime monitor (3rd, after sandbox bump) | ✅ APPROVED | 2 | 379s | $0.58 | Round 1 REJECT → Builder fixed → Round 2 APPROVE (degraded mode, Gemini 503'd) |
| 16 | Solana CLI (2nd, after sandbox bump) | ❌ FAILED (`test-2`) | — | 229s | $0.37 | Never reached reviewer; sandbox-timeout error gone |
| 17 | Express todo API (re-run) | ✅ APPROVED | 1 | 274s | $0.43 | Nothing — degraded mode (Gemini 503'd), Claude+GPT approved |

## 2. Win highlights

- **#2 — Express `/health`** ($0.07, 104s, 1 round): the cleanest run of the session. Spec was unambiguous, Builder shipped 3 files first try, Contrarian approved, `curl localhost:3000/health` returned `{"status":"ok","timestamp":"…"}` exactly as specified. Closest Qontrary got to vanilla Claude Code's price/latency.
- **#7a — CSV summary** ($1.13, 725s, 3 rounds): the only run where the **reject → fix → approve loop did something a one-shot wouldn't have**. Contrarian caught a real spec violation (`First 3 Rows: (none)` printed across two lines instead of one for header-only inputs) on rounds 1 and 2. Builder fixed it on round 3 and the final code matched the spec exactly. This is Qontrary's value proposition working as designed.
- **#15 — Cron uptime monitor** ($0.58, 379s, 2 rounds): the hardest-won approval. This task failed three different ways across runs #9, #10, and an attempt that died in the planner. Run #15 finally cleared every Builder task, got REJECTed in round 1, was rebuilt, and was APPROVEd in round 2 — in **degraded mode**, because Gemini 503'd 3× and the 2/3 consensus path (Claude + GPT) carried it. Two pieces of resilience work paying off in one run.
- **#17 — Express todo API** ($0.43, 274s, 1 round, 12 files): the largest one-shot approval. 12-file scaffold including rate-limiting, input validation, and error handling, also approved in degraded mode. Direct improvement over run #12 (same task, FAILED at $0.54) after the verify-rules and sandbox-lifetime fixes.

## 3. Framework bugs found and fixed during dogfood

| # | Bug | Symptom | Fix |
|---|---|---|---|
| 1 | **Spec Agent rejected fenced JSON** | Run #2 first attempt: `SpecAgentError: Model did not return valid JSON` because Claude wrapped the response in ` ```json ` fences | One-line slice in `spec-agent.ts` (later replaced by shared util) |
| 2 | **Planner rejected versioned npm names** | Run #2: `Invalid npm package name: express@^4.18.2` | Strip trailing `@version` before regex check in `planner-agent.ts:isValidNpmName` |
| 3 | **Contrarian rubber-stamped a failed build** | Run #3: `final_build.status === "failed"` but verdict came back APPROVED | Orchestrator now transitions straight to `FAILED` and throws if `build.status === "failed"`, before invoking Contrarian |
| 4 | **Builder also choked on fenced JSON** | Run #3: 5× `BuilderAgentError: Model did not return valid JSON` from `callModelForTask` | Same fence-stripping fix in `builder-agent.ts` |
| 5 | **Builder `max_tokens: 4096` truncated mid-string** | Run #7: model JSON cut off at varying positions on long files | Bumped to 16384; also added position-aware extractor that truncates to the failure offset |
| 6 | **Three+ duplicate `extractJson` implementations** | Same defect re-discovered in spec, builder, contrarian, and planner agents | Hoisted to shared `packages/core/src/utils/extract-json.ts`; tries raw parse → position-truncate → outermost ` ``` ` → first-`{` to last-`}` |
| 7 | **Self-fix loop burned 5 retries on deterministic errors** | Run #6: Builder spent ~$0.32 retrying the identical JSON parse failure | Track last error signature; bail early after 1 repeat |
| 8 | **CLI lost everything on hard-fail** | Run #5: orchestrator threw, no artifacts written, debugging required re-running | Added `Orchestrator.partialResult()`; CLI now writes partial files + `qontrary-failure.json` to `qontrary-output/{build_id}/` on failure |
| 9 | **Builder couldn't see prior tasks' file contents** | Run #7b: round-2 implementation regressed against round-1 tests because Builder had no visibility into already-written files | `buildTaskPrompt` now appends `--- path ---\n{content}` blocks for every file in the `collected` map (4000-char per-file cap, 24000-char total budget) |
| 10 | **Verify commands too aggressive for setup/config tasks** | Runs #9, #10, #14: tasks that just wrote a config file tried to *execute* it via `tsc`/`node` before deps existed | Rewrote Builder system prompt with per-task-type rules: `setup`/`config` → `test -f` only; `implement` → static check; `test` → only place real test runners are allowed. Threaded `task.type` into per-task prompt. |
| 11 | **Internal sandbox-lifetime guard too short** | Run #11: `The sandbox was not found: This error is likely due to sandbox timeout` mid-build on long Solana CLI run | `SANDBOX_TIMEOUT_MS` 10 → 30 min in `e2b-runner.ts` (run #16 confirmed the symptom is gone) |

The same defect was rediscovered in three different agents before #6 hoisted `extractJson` into a shared util — the strongest argument the dogfood produced for cross-cutting utilities being worth the indirection cost.

## 4. Known limitations (with root causes)

- **Complex frontend builds (React/TS scaffolds).** Two attempts on the React sortable crypto table got further each time but never APPROVED. Root causes: (a) per-task verify loop fights with the toolchain coming up incrementally (`tsc` runs before all `.tsx` files exist), (b) prior-files context inflates per-call token usage ~4× (1.5–3k → 7–12k), (c) Builder regressed implementations against tests it had already written on round 2 of run #7b. The framework's per-task model is a poor fit for projects where files reference each other in cycles.
- **Network-dependent tests.** Runs #11, #12, and #16 all died on `test`-type tasks where the test suite tried to reach a real upstream (Helius, an in-process Express server, etc.) from inside the sandbox without a key, mock, or network egress. The "test tasks may run real test runners" rule is correct in principle but useless when the tests need infrastructure the sandbox can't provide. Needs either: a network-mock fixture, an explicit "skip integration tests in sandbox" mode, or a way to inject env/keys per build.
- **E2B sandbox lifetime on large projects.** Even after the 10→30 min bump, run #11's original symptom traced to E2B's *own* per-sandbox cap, which we don't pass when calling `Sandbox.create()`. Builds with many tasks + the prior-files context (each turn ~150–400s sandbox time, plus model latency) can still age out. The bump helped run #16 but isn't a general fix.
- **Builder sometimes returns prose instead of JSON despite the system prompt** (run #8: `"Looking at the task..."`). `extractJson` correctly can't recover from text with no `{` in it. Needs a stronger system prompt or a single retry-on-prose recovery step.
- **Gemini 503s are persistent** (seen in 3+ runs). The retry-with-backoff + 2/3 degraded-mode consensus carries the build, but it means many "approvals" are actually 2-reviewer approvals — a quieter quality bar than designed.
- **Planner nondeterminism** (`tasks[N] invalid`, malformed task entries) caused multiple wasted run starts. The validator throws on the first bad field; a single retry with the validation error fed back to the model would probably recover most of these.

## 5. Cost analysis

| Bucket | Count | Total | Average |
|---|---|---|---|
| Total spend across all runs | 18 builds | **$7.01** | $0.39 / build |
| ✅ Truly APPROVED | 6 | $2.90 | **$0.48 / approved build** |
| ⚠️ False-positive APPROVED (run #3) | 1 | $0.47 | — |
| ❌ FAILED | 11 | $3.64 | **$0.33 / failed build** |

A few things to read out of these numbers:
- Failed builds are *cheaper* on average than approved ones, because the early-bail and orchestrator fail-fast paths kill most failures inside ~$0.20. Runs #13 ($0.03) and #14 ($0.05) are the floor.
- The most expensive run was #7a CSV ($1.13, 3 rounds) — and it was also the only run where the reject loop produced *more correct* code than a one-shot would have. The loop is expensive; when it works, it works.
- $7.01 / 6 successful builds ≈ **$1.17 amortised cost per shipped artifact** if you treat the dogfood iteration as the cost of getting one build out the door. That's ~50× vanilla Claude Code's marginal cost.

## 6. Comparison: what would vanilla Claude Code have shipped?

Per-task baseline (one-shot, no review): ~$0.01–$0.03 and ~10–30 seconds. Vanilla Claude Code would have produced *some working artifact* for **15 of the 18 tasks** in this set, including all 11 of the ones Qontrary failed. The cases where Qontrary clearly added value:

- **Run #7a CSV** — vanilla would have shipped the `First 3 Rows: (none)` two-line bug. Qontrary's blind tests caught it across two reject rounds; the third-round build was correct. *Net win for Qontrary if that bug would have caused a downstream incident; net loss otherwise.*
- **Run #15 cron** — round 1 was REJECTed and the round 2 rebuild was APPROVED. Without seeing the round 1 issues I can't say whether they were real spec violations or style nitpicks the filter let through.
- **Run #17 Express todo** — 12 files including rate-limiting, validation, error handling, all approved one-shot. Vanilla could have produced the same — Qontrary's added value here is the cross-model sign-off, not the code itself.

The cases where vanilla Claude Code would have done **strictly better**:

- **Runs #5, #6, #8, #9, #10, #13, #14, #16** — Qontrary failed to produce a working artifact for tasks vanilla would have one-shot in 10–30s for 1–3 cents. These are mostly small Node scripts where the per-task verify loop is pure friction.
- **Runs #11, #12, #16** — `test`-task failures on tasks where vanilla would have skipped the test step entirely and shipped a working implementation.

The cases where Qontrary's *worst* failure mode showed up:

- **Run #3** — APPROVED a build whose `final_build.status === "failed"`. Vanilla would have visibly errored. **The single most dangerous bug we found**, fixed in run #4.

### Honest readout

Qontrary's value lives at the right tail of the task-importance distribution. For leaf scripts and one-off tools (the bulk of this dogfood set), the framework is ~50× more expensive than vanilla Claude Code, ~15× slower, and produces working code less often. For tasks where a silent spec violation would be expensive (run #7a CSV is the canonical example, and a hypothetical production API endpoint would be another), the reject → fix loop and the cross-model sign-off are real, paid-for safety nets. The dogfood didn't include enough "expensive-if-wrong" tasks to put a number on that side of the trade — the closest was run #17's todo API, and there the multi-reviewer pass didn't actually catch anything.

Net: **the framework works**, **the safety nets are real**, and **the cost-to-value ratio is task-dependent and currently weighted against small tasks**. The biggest concrete improvement would be making `test`-type tasks work in the sandbox — that's the single failure mode that ate the most $ in this session.
