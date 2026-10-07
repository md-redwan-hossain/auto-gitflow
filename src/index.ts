#!/usr/bin/env bun
import * as p from "@clack/prompts";
import chalk from "chalk";
import { Command } from "commander";
import { createGitClient } from "./create-git-client.ts";
import { runDoctor } from "./doctor.ts";
import type { GitHostClient } from "./git-host.ts";
import { loadConfig, loadToken } from "./load-config.ts";
import { parseRepoUrl } from "./parse-repo-url.ts";
import {
  confirmCreatePrStep,
  resolveSourceBranch,
} from "./source-branch.ts";
import { runCreatePrStep } from "./steps/create-pr.ts";
import { runListPrStep } from "./steps/list-pr.ts";
import {
  collectEagerWorkflowInputs,
  runWorkflowStep,
} from "./steps/run-workflow.ts";
import type {
  CreatePrStep,
  EagerInputMap,
  RepoConfig,
  RunWorkflowStep,
  SkippedStepSet,
  SourceBranchMap,
  Step,
} from "./schema.ts";

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("gitrung")
    .description("Run declarative Gitea/GitHub PR + workflow automation steps")
    .option("-r, --repo <label>", "Repo label from config.jsonc")
    .option("-c, --config <path>", "Path to config.jsonc")
    .action(async () => {
      const opts = program.opts<{ repo?: string; config?: string }>();
      await runPipeline(opts);
    });

  program
    .command("doctor")
    .description("Parse and validate config.jsonc")
    .option("-c, --config <path>", "Path to config.jsonc")
    .action((opts: { config?: string }) => {
      runDoctor(opts.config ?? program.opts<{ config?: string }>().config);
    });

  await program.parseAsync(process.argv);
}

async function runPipeline(opts: {
  repo?: string;
  config?: string;
}): Promise<void> {
  p.intro("gitrung");

  const config = loadConfig(opts.config);

  const repo = await pickRepo(config, opts.repo);
  const token = loadToken(repo.gitPlatform);
  const parsed = parseRepoUrl(repo.url, repo.gitPlatform);
  const client = createGitClient(parsed, token);

  p.log.info(
    `Repo: ${repo.label} (${parsed.owner}/${parsed.repo}) [${repo.gitPlatform}]`,
  );
  p.log.info(`${repo.steps.length} step(s)`);

  const alreadyRan = await runBypassEagerListPrSteps(client, repo.steps);

  const { eagerInputs, skipped, sourceBranches } = await runEagerPreflight(
    client,
    repo.label,
    repo.steps,
  );

  for (const [index, step] of repo.steps.entries()) {
    p.log.step(
      formatStepLine(
        index,
        repo.steps.length,
        step,
        sourceBranches.get(index),
      ),
    );
    await runStep(
      client,
      repo.label,
      step,
      index,
      eagerInputs,
      skipped,
      sourceBranches,
      alreadyRan,
    );
  }

  p.outro("Done.");
}

/** list-pr steps with bypassEager run before eager prompts; indices skipped in the main loop. */
async function runBypassEagerListPrSteps(
  client: GitHostClient,
  steps: Step[],
): Promise<Set<number>> {
  const alreadyRan = new Set<number>();

  for (const [index, step] of steps.entries()) {
    if (step.type !== "list-pr" || !step.bypassEager) continue;
    p.log.step(formatStepLine(index, steps.length, step));
    await runListPrStep(client, step);
    alreadyRan.add(index);
  }

  return alreadyRan;
}

async function runEagerPreflight(
  client: GitHostClient,
  label: string,
  steps: Step[],
): Promise<{
  eagerInputs: EagerInputMap;
  skipped: SkippedStepSet;
  sourceBranches: SourceBranchMap;
}> {
  const skipped: SkippedStepSet = new Set();
  const sourceBranches: SourceBranchMap = new Map();

  for (const [index, step] of steps.entries()) {
    if (step.type !== "create-pr") continue;
    if (!step.eager || !step.needConfirmation) continue;

    const source = await resolveSourceBranch(label, step);
    const result = await confirmCreatePrStep(
      step.destinationBranch,
      source,
      label,
    );
    if (result.action === "skip") {
      skipped.add(index);
      p.log.info(
        `Will skip step ${index + 1}: ${formatStepLabel(step, source)}`,
      );
      continue;
    }
    sourceBranches.set(index, result.sourceBranch);
  }

  for (const [index, step] of steps.entries()) {
    if (step.type !== "run-workflow" || !step.eager || !step.needConfirmation) {
      continue;
    }
    if (skipped.has(index)) continue;

    const ok = await confirmRunWorkflowStep(step);
    if (!ok) {
      skipped.add(index);
      p.log.info(`Will skip step ${index + 1}: ${formatStepLabel(step)}`);
    }
  }

  const eagerWorkflowSteps: { step: RunWorkflowStep; index: number }[] = [];
  for (const [index, step] of steps.entries()) {
    if (step.type !== "run-workflow" || !step.eager) continue;
    if (skipped.has(index)) continue;
    eagerWorkflowSteps.push({ step, index });
  }

  if (eagerWorkflowSteps.length === 0) {
    return { eagerInputs: new Map(), skipped, sourceBranches };
  }

  p.log.info(
    `Collecting eager inputs for ${eagerWorkflowSteps.length} workflow(s)…`,
  );
  const eagerInputs = await collectEagerWorkflowInputs(
    client,
    label,
    eagerWorkflowSteps,
  );
  return { eagerInputs, skipped, sourceBranches };
}

async function confirmRunWorkflowStep(step: RunWorkflowStep): Promise<boolean> {
  const answer = await p.confirm({
    message: `Run workflow ${step.workflow} @ ${step.ref}?`,
    initialValue: true,
  });

  if (p.isCancel(answer)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  return answer;
}

async function pickRepo(
  repos: RepoConfig[],
  label?: string,
): Promise<RepoConfig> {
  if (label) {
    const found = repos.find((r) => r.label === label);
    if (!found) {
      throw new Error(
        `Repo label "${label}" not found. Available: ${repos
          .map((r) => r.label)
          .join(", ")}`,
      );
    }
    return found;
  }

  if (repos.length === 1) {
    return repos[0]!;
  }

  const selected = await p.select({
    message: "Select a repo",
    options: repos.map((r) => ({
      value: r.label,
      label: `${r.label} [${r.gitPlatform}]`,
      hint: r.url,
    })),
  });

  if (p.isCancel(selected)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  return repos.find((r) => r.label === selected)!;
}

function formatStepParams(step: Step, resolvedSource?: string): string {
  if (step.type === "create-pr") {
    const source = resolvedSource ?? step.sourceBranch ?? "prompt";
    return [
      `source=${source}`,
      `destination=${step.destinationBranch}`,
      `mergeWhenChecksSucceed=${step.mergeWhenChecksSucceed}`,
      `waitFor=${step.waitFor.join(",") || "—"}`,
      `eager=${step.eager}`,
      `needConfirmation=${step.needConfirmation}`,
    ].join(", ");
  }
  if (step.type === "list-pr") {
    const parts = [`status=${step.status}`];
    if (step.user) parts.push(`user=${step.user}`);
    parts.push(`bypassEager=${step.bypassEager}`);
    return parts.join(", ");
  }
  return [
    `workflow=${step.workflow}`,
    `ref=${step.ref}`,
    `eager=${step.eager}`,
    `needConfirmation=${step.needConfirmation}`,
  ].join(", ");
}

function formatStepLabel(step: Step, resolvedSource?: string): string {
  return `${chalk.green(step.type)} (${formatStepParams(step, resolvedSource)})`;
}

function formatStepLine(
  index: number,
  total: number,
  step: Step,
  resolvedSource?: string,
): string {
  return `${chalk.yellow(`[${index + 1}/${total}]`)} ${formatStepLabel(step, resolvedSource)}`;
}

async function runStep(
  client: GitHostClient,
  label: string,
  step: Step,
  stepIndex: number,
  eagerInputs: EagerInputMap,
  skipped: SkippedStepSet,
  sourceBranches: SourceBranchMap,
  alreadyRan: Set<number>,
): Promise<void> {
  if (alreadyRan.has(stepIndex)) {
    p.log.info(`Already ran (bypassEager): ${formatStepLabel(step)}`);
    return;
  }

  if (skipped.has(stepIndex)) {
    p.log.info(`Skipped (declined earlier): ${formatStepLabel(step)}`);
    return;
  }

  if (step.type === "create-pr") {
    await runCreatePrWithResolve(
      client,
      label,
      step,
      stepIndex,
      sourceBranches,
    );
    return;
  }

  if (
    step.type === "run-workflow" &&
    step.needConfirmation &&
    !step.eager
  ) {
    const ok = await confirmRunWorkflowStep(step);
    if (!ok) {
      p.log.info(`Skipped: ${formatStepLabel(step)}`);
      return;
    }
  }

  if (step.type === "run-workflow") {
    await runWorkflowStep(client, label, step, { stepIndex, eagerInputs });
    return;
  }
  if (step.type === "list-pr") {
    await runListPrStep(client, step);
    return;
  }
  const _exhaustive: never = step;
  throw new Error(`Unknown step: ${JSON.stringify(_exhaustive)}`);
}

async function runCreatePrWithResolve(
  client: GitHostClient,
  label: string,
  step: CreatePrStep,
  stepIndex: number,
  sourceBranches: SourceBranchMap,
): Promise<void> {
  let source = sourceBranches.get(stepIndex);

  if (source === undefined) {
    source = await resolveSourceBranch(label, step);

    if (step.needConfirmation && !step.eager) {
      const result = await confirmCreatePrStep(
        step.destinationBranch,
        source,
        label,
      );
      if (result.action === "skip") {
        p.log.info(`Skipped: ${formatStepLabel(step, source)}`);
        return;
      }
      source = result.sourceBranch;
    }

    sourceBranches.set(stepIndex, source);
  }

  await runCreatePrStep(client, step, { sourceBranch: source });
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  p.log.error(message);
  process.exit(1);
});
