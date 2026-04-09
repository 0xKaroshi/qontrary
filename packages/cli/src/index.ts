#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import dotenv from "dotenv";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Orchestrator } from "@qontrary/core";

dotenv.config();

const program = new Command();

program
  .name("qontrary")
  .description("Multi-agent build pipeline (Spec → Plan → Build → Contrarian)")
  .argument("<task>", "what to build")
  .option("-s, --stack <stack>", "preferred stack (e.g. 'Next.js, Tailwind')")
  .option("-c, --max-cost <usd>", "max USD cost per build", "10")
  .option("-o, --out <dir>", "output directory", "./qontrary-output")
  .action(async (task: string, opts: { stack?: string; maxCost: string; out: string }) => {
    await runBuild(task, opts);
  });

interface RunOpts {
  stack?: string;
  maxCost: string;
  out: string;
}

/** Pretty-print an event line for the given agent. */
function tag(agent: string): string {
  switch (agent) {
    case "spec":
      return chalk.blue("[SPEC]");
    case "planner":
      return chalk.cyan("[PLAN]");
    case "builder":
      return chalk.green("[BUILD]");
    case "contrarian":
      return chalk.yellow("[CONTRARIAN]");
    default:
      return chalk.gray(`[${agent.toUpperCase()}]`);
  }
}

/** Drive a single build, streaming events to the terminal. */
async function runBuild(task: string, opts: RunOpts): Promise<void> {
  const maxCost = Number(opts.maxCost);
  if (!Number.isFinite(maxCost) || maxCost <= 0) {
    console.error(chalk.red(`Invalid --max-cost: ${opts.maxCost}`));
    process.exit(2);
  }

  if (!process.env.ANTHROPIC_API_KEY || !process.env.OPENAI_API_KEY || !process.env.GEMINI_API_KEY) {
    console.error(
      chalk.red(
        "Missing API keys. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, and GEMINI_API_KEY in your .env file.",
      ),
    );
    process.exit(2);
  }
  if (!process.env.E2B_API_KEY) {
    console.error(chalk.red("Missing E2B_API_KEY. Sandbox execution requires E2B."));
    process.exit(2);
  }

  console.log(chalk.bold(`\nQontrary build: `) + task + "\n");

  const orch = new Orchestrator({ maxCostUsd: maxCost });
  const spinner = ora({ text: "starting…", color: "gray" }).start();

  orch.on("build:state_changed", (e: { from: string; to: string }) => {
    spinner.text = chalk.gray(`${e.from} → ${e.to}`);
  });
  orch.on("agent:started", (e: { agent: string; round: number }) => {
    spinner.stopAndPersist({ symbol: tag(e.agent), text: `started${e.round ? ` (round ${e.round})` : ""}` });
    spinner.start(chalk.gray(`${e.agent} working…`));
  });
  orch.on("agent:completed", (e: { agent: string; output_summary: string }) => {
    spinner.stopAndPersist({ symbol: tag(e.agent), text: chalk.dim(e.output_summary) });
    spinner.start(chalk.gray("…"));
  });
  orch.on("agent:error", (e: { agent: string; error: string }) => {
    spinner.stopAndPersist({ symbol: chalk.red("[ERR]"), text: `${e.agent}: ${e.error}` });
    spinner.start(chalk.gray("…"));
  });
  orch.on("build:cost_update", (e: { total_cost_usd: number }) => {
    spinner.text = chalk.gray(`cost so far: $${e.total_cost_usd.toFixed(4)}`);
  });

  try {
    const result = await orch.run(task, opts.stack);
    spinner.stop();

    const verdictColor =
      result.status === "APPROVED"
        ? chalk.green
        : result.status === "ESCALATED"
          ? chalk.yellow
          : chalk.red;

    console.log("\n" + verdictColor(chalk.bold(`Verdict: ${result.status}`)));
    console.log(chalk.gray(`Build ID:    ${result.build_id}`));
    console.log(chalk.gray(`Rounds:      ${result.total_rounds}`));
    console.log(chalk.gray(`Files:       ${result.files.length}`));
    console.log(chalk.gray(`Time:        ${(result.total_time_ms / 1000).toFixed(1)}s`));
    console.log(chalk.gray(`Total cost:  $${result.total_cost_usd.toFixed(4)}`));

    const lastReview = result.contrarian_reviews[result.contrarian_reviews.length - 1];
    if (lastReview && lastReview.issues.length > 0) {
      console.log("\n" + chalk.bold("Issues:"));
      for (const issue of lastReview.issues) {
        console.log(
          `  ${chalk.red(issue.severity)} ${chalk.yellow(issue.category)} — ${issue.description}`,
        );
        if (issue.suggested_fix) console.log(chalk.gray(`    fix: ${issue.suggested_fix}`));
      }
    }

    const outDir = resolve(opts.out, result.build_id);
    mkdirSync(outDir, { recursive: true });
    for (const f of result.files) {
      const dest = join(outDir, f.path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, f.content);
    }
    writeFileSync(join(outDir, "qontrary-result.json"), JSON.stringify(result, null, 2));
    console.log("\n" + chalk.green(`Files written to ${outDir}`));

    process.exit(result.status === "APPROVED" ? 0 : 1);
  } catch (err) {
    spinner.stop();
    console.error("\n" + chalk.red(`Build failed: ${String(err)}`));
    try {
      const partial = orch.partialResult();
      const outDir = resolve(opts.out, partial.build_id);
      mkdirSync(outDir, { recursive: true });
      for (const f of partial.files ?? []) {
        const dest = join(outDir, f.path);
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, f.content);
      }
      writeFileSync(
        join(outDir, "qontrary-failure.json"),
        JSON.stringify({ error: String(err), ...partial }, null, 2),
      );
      console.error(chalk.gray(`Partial output written to ${outDir}`));
    } catch (writeErr) {
      console.error(chalk.gray(`(could not persist partial output: ${String(writeErr)})`));
    }
    process.exit(1);
  }
}

program.parseAsync(process.argv).catch((err) => {
  console.error(chalk.red(String(err)));
  process.exit(1);
});
