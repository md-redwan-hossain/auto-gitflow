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
  promptMergePrNumber,
  runMergePrStep,
} from "./steps/merge-pr.ts";
import {
  collectEagerWorkflowInputs,
  runWorkflowStep,
} from "./steps/run-workflow.ts";
import {
  isStepGroup,
  stepKey,
  type CreatePrStep,
  type EagerInputMap,
  type LeafStep,
  type MergePrNumberMap,
  type PipelineStep,
  type RepoConfig,
  type RunWorkflowStep,
  type SelectedSubStepMap,
  type SkippedStepSet,
  type SourceBranchMap,
  type StepGroup,
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

  const {
    eagerInputs,
    skipped,
    sourceBranches,
    selectedSubSteps,
    mergePrNumbers,
  } = await runEagerPreflight(client, repo.label, repo.steps);

  for (const [index, step] of repo.steps.entries()) {
    if (isStepGroup(step)) {
      await runGroupStep(
        client,
        repo.label,
        step,
        index,
        repo.steps.length,
        {
          eagerInputs,
          skipped,
          sourceBranches,
          selectedSubSteps,
          mergePrNumbers,
          alreadyRan,
        },
      );
      continue;
    }

    p.log.step(
      formatStepLine(
        index,
        repo.steps.length,
        step,
        sourceBranches.get(stepKey(index)),
      ),
    );
    await runLeafStep(
      client,
      repo.label,
      step,
      stepKey(index),
      index,
      repo.steps.length,
      {
        eagerInputs,
        skipped,
        sourceBranches,
        mergePrNumbers,
        alreadyRan,
      },
    );
  }

  p.outro("Done.");
}

type PipelineMaps = {
  eagerInputs: EagerInputMap;
  skipped: SkippedStepSet;
  sourceBranches: SourceBranchMap;
  selectedSubSteps: SelectedSubStepMap;
  mergePrNumbers: MergePrNumberMap;
  alreadyRan: Set<number>;
};

/** list-pr steps with bypassEager run before eager prompts; indices skipped in the main loop. */
async function runBypassEagerListPrSteps(
  client: GitHostClient,
  steps: PipelineStep[],
): Promise<Set<number>> {
  const alreadyRan = new Set<number>();

  for (const [index, step] of steps.entries()) {
    if (isStepGroup(step)) continue;
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
  steps: PipelineStep[],
): Promise<{
  eagerInputs: EagerInputMap;
  skipped: SkippedStepSet;
  sourceBranches: SourceBranchMap;
  selectedSubSteps: SelectedSubStepMap;
  mergePrNumbers: MergePrNumberMap;
}> {
  const skipped: SkippedStepSet = new Set();
  const sourceBranches: SourceBranchMap = new Map();
  const selectedSubSteps: SelectedSubStepMap = new Map();
  const mergePrNumbers: MergePrNumberMap = new Map();

  // Eager groups: pick child first
  for (const [index, step] of steps.entries()) {
    if (!isStepGroup(step) || !step.eager) continue;
    const subIndex = await selectSubStep(step, index, steps.length);
    selectedSubSteps.set(index, subIndex);
  }

  // create-pr confirms (top-level + selected eager-group children)
  for (const [index, step] of steps.entries()) {
    if (isStepGroup(step)) {
      if (!step.eager) continue;
      const subIndex = selectedSubSteps.get(index);
      if (subIndex === undefined) continue;
      const child = step.subSteps[subIndex]!;
      if (child.type !== "create-pr") continue;
      if (!child.eager || !child.needConfirmation) continue;

      const key = stepKey(index, subIndex);
      const source = await resolveSourceBranch(label, child);
      const result = await confirmCreatePrStep(
        child.destinationBranch,
        source,
        label,
        index,
        steps.length,
      );
      if (result.action === "skip") {
        skipped.add(index);
        p.log.info(
          `Will skip step ${index + 1}: ${formatStepLabel(child, source)}`,
        );
        continue;
      }
      sourceBranches.set(key, result.sourceBranch);
      continue;
    }

    if (step.type !== "create-pr") continue;
    if (!step.eager || !step.needConfirmation) continue;

    const key = stepKey(index);
    const source = await resolveSourceBranch(label, step);
    const result = await confirmCreatePrStep(
      step.destinationBranch,
      source,
      label,
      index,
      steps.length,
    );
    if (result.action === "skip") {
      skipped.add(index);
      p.log.info(
        `Will skip step ${index + 1}: ${formatStepLabel(step, source)}`,
      );
      continue;
    }
    sourceBranches.set(key, result.sourceBranch);
  }

  // run-workflow confirms
  for (const [index, step] of steps.entries()) {
    if (skipped.has(index)) continue;

    if (isStepGroup(step)) {
      if (!step.eager) continue;
      const subIndex = selectedSubSteps.get(index);
      if (subIndex === undefined) continue;
      const child = step.subSteps[subIndex]!;
      if (child.type !== "run-workflow" || !child.eager || !child.needConfirmation) {
        continue;
      }
      const ok = await confirmRunWorkflowStep(child, index, steps.length);
      if (!ok) {
        skipped.add(index);
        p.log.info(`Will skip step ${index + 1}: ${formatStepLabel(child)}`);
      }
      continue;
    }

    if (step.type !== "run-workflow" || !step.eager || !step.needConfirmation) {
      continue;
    }
    const ok = await confirmRunWorkflowStep(step, index, steps.length);
    if (!ok) {
      skipped.add(index);
      p.log.info(`Will skip step ${index + 1}: ${formatStepLabel(step)}`);
    }
  }

  // merge-pr PR numbers for selected eager-group children
  for (const [index, step] of steps.entries()) {
    if (skipped.has(index)) continue;
    if (!isStepGroup(step) || !step.eager) continue;
    const subIndex = selectedSubSteps.get(index);
    if (subIndex === undefined) continue;
    const child = step.subSteps[subIndex]!;
    if (child.type !== "merge-pr") continue;

    const key = stepKey(index, subIndex);
    const prNumber = await promptMergePrNumber(
      `Enter PR number for step ${index + 1} (merge-pr)`,
    );
    mergePrNumbers.set(key, prNumber);
  }

  // Top-level merge-pr is never eager-collected (no leaf eager on merge-pr)

  const eagerWorkflowSteps: {
    step: RunWorkflowStep;
    key: string;
    labelHint: string;
  }[] = [];

  for (const [index, step] of steps.entries()) {
    if (skipped.has(index)) continue;

    if (isStepGroup(step)) {
      if (!step.eager) continue;
      const subIndex = selectedSubSteps.get(index);
      if (subIndex === undefined) continue;
      const child = step.subSteps[subIndex]!;
      if (child.type !== "run-workflow" || !child.eager) continue;
      eagerWorkflowSteps.push({
        step: child,
        key: stepKey(index, subIndex),
        labelHint: `step ${index + 1} / sub ${subIndex + 1}`,
      });
      continue;
    }

    if (step.type !== "run-workflow" || !step.eager) continue;
    eagerWorkflowSteps.push({
      step,
      key: stepKey(index),
      labelHint: `step ${index + 1}`,
    });
  }

  if (eagerWorkflowSteps.length === 0) {
    return {
      eagerInputs: new Map(),
      skipped,
      sourceBranches,
      selectedSubSteps,
      mergePrNumbers,
    };
  }

  p.log.info(
    `Collecting eager inputs for ${eagerWorkflowSteps.length} workflow(s)…`,
  );
  const eagerInputs = await collectEagerWorkflowInputs(
    client,
    label,
    eagerWorkflowSteps,
  );
  return {
    eagerInputs,
    skipped,
    sourceBranches,
    selectedSubSteps,
    mergePrNumbers,
  };
}

async function selectSubStep(
  group: StepGroup,
  groupIndex: number,
  totalSteps: number,
): Promise<number> {
  const selected = await p.select({
    message: `Which sub-step to run for ${chalk.yellow(`[${groupIndex + 1}/${totalSteps}]`)}?`,
    options: group.subSteps.map((child, i) => ({
      value: i,
      label: formatStepLabel(child),
    })),
  });

  if (p.isCancel(selected)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  return selected;
}

async function confirmRunWorkflowStep(
  step: RunWorkflowStep,
  stepIndex: number,
  totalSteps: number,
): Promise<boolean> {
  const answer = await p.confirm({
    message: `Run ${chalk.yellow(`[${stepIndex + 1}/${totalSteps}]`)}: ${step.workflow} @ ${step.ref}?`,
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

function formatStepParams(step: LeafStep, resolvedSource?: string): string {
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
  if (step.type === "merge-pr") {
    if (step.when.length === 0) return "when=—";
    return step.when
      .map(
        (w) =>
          `when: destinationBranch=${w.destinationBranch}, waitFor=${w.waitFor.join(",")}`,
      )
      .join("; ");
  }
  return [
    `workflow=${step.workflow}`,
    `ref=${step.ref}`,
    `eager=${step.eager}`,
    `needConfirmation=${step.needConfirmation}`,
  ].join(", ");
}

function formatStepLabel(step: LeafStep, resolvedSource?: string): string {
  return `${chalk.green(step.type)} (${formatStepParams(step, resolvedSource)})`;
}

function formatStepLine(
  index: number,
  total: number,
  step: LeafStep,
  resolvedSource?: string,
): string {
  return `${chalk.yellow(`[${index + 1}/${total}]`)} ${formatStepLabel(step, resolvedSource)}`;
}

async function runGroupStep(
  client: GitHostClient,
  label: string,
  group: StepGroup,
  groupIndex: number,
  totalSteps: number,
  maps: PipelineMaps,
): Promise<void> {
  if (maps.skipped.has(groupIndex)) {
    const subIndex = maps.selectedSubSteps.get(groupIndex);
    const child =
      subIndex !== undefined ? group.subSteps[subIndex] : undefined;
    p.log.info(
      child
        ? `Skipped (declined earlier): ${formatStepLabel(child, maps.sourceBranches.get(stepKey(groupIndex, subIndex)))}`
        : `Skipped (declined earlier): sub-steps (eager=${group.eager})`,
    );
    return;
  }

  let subIndex = maps.selectedSubSteps.get(groupIndex);
  if (subIndex === undefined) {
    subIndex = await selectSubStep(group, groupIndex, totalSteps);
    maps.selectedSubSteps.set(groupIndex, subIndex);
  }

  const child = group.subSteps[subIndex]!;
  const key = stepKey(groupIndex, subIndex);
  p.log.step(
    formatStepLine(
      groupIndex,
      totalSteps,
      child,
      maps.sourceBranches.get(key),
    ),
  );

  await runLeafStep(
    client,
    label,
    child,
    key,
    groupIndex,
    totalSteps,
    {
      ...maps,
      // Group itself is never alreadyRan via bypassEager
      alreadyRan: new Set(),
    },
    { nestedUnderGroup: true },
  );
}

async function runLeafStep(
  client: GitHostClient,
  label: string,
  step: LeafStep,
  key: string,
  topIndex: number,
  totalSteps: number,
  maps: Omit<PipelineMaps, "selectedSubSteps">,
  opts?: { nestedUnderGroup?: boolean },
): Promise<void> {
  if (!opts?.nestedUnderGroup && maps.alreadyRan.has(topIndex)) {
    p.log.info(`Already ran (bypassEager): ${formatStepLabel(step)}`);
    return;
  }

  if (!opts?.nestedUnderGroup && maps.skipped.has(topIndex)) {
    p.log.info(`Skipped (declined earlier): ${formatStepLabel(step)}`);
    return;
  }

  if (step.type === "create-pr") {
    await runCreatePrWithResolve(
      client,
      label,
      step,
      key,
      topIndex,
      totalSteps,
      maps.sourceBranches,
    );
    return;
  }

  if (step.type === "run-workflow" && step.needConfirmation) {
    // Eager preflight already confirmed when inputs were collected for this key
    if (!maps.eagerInputs.has(key)) {
      const ok = await confirmRunWorkflowStep(step, topIndex, totalSteps);
      if (!ok) {
        p.log.info(`Skipped: ${formatStepLabel(step)}`);
        return;
      }
    }
  }

  if (step.type === "run-workflow") {
    await runWorkflowStep(client, label, step, {
      stepKey: key,
      eagerInputs: maps.eagerInputs,
    });
    return;
  }

  if (step.type === "list-pr") {
    await runListPrStep(client, step);
    return;
  }

  if (step.type === "merge-pr") {
    const precollected = maps.mergePrNumbers.get(key);
    await runMergePrStep(client, step, {
      prNumber: precollected,
    });
    return;
  }

  const _exhaustive: never = step;
  throw new Error(`Unknown step: ${JSON.stringify(_exhaustive)}`);
}

async function runCreatePrWithResolve(
  client: GitHostClient,
  label: string,
  step: CreatePrStep,
  key: string,
  stepIndex: number,
  totalSteps: number,
  sourceBranches: SourceBranchMap,
): Promise<void> {
  let source = sourceBranches.get(key);

  if (source === undefined) {
    source = await resolveSourceBranch(label, step);

    // Confirm here when not already handled in eager preflight (sourceBranches unset)
    if (step.needConfirmation) {
      const result = await confirmCreatePrStep(
        step.destinationBranch,
        source,
        label,
        stepIndex,
        totalSteps,
      );
      if (result.action === "skip") {
        p.log.info(`Skipped: ${formatStepLabel(step, source)}`);
        return;
      }
      source = result.sourceBranch;
    }

    sourceBranches.set(key, source);
  }

  await runCreatePrStep(client, step, { sourceBranch: source });
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  p.log.error(message);
  process.exit(1);
});
