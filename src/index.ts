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
  persistSourceBranch,
  promptSourceBranch,
  resolveSourceBranch,
} from "./source-branch.ts";
import {
  runCreatePrStep,
  validateCreatePrRemote,
} from "./steps/create-pr.ts";
import { runListPrStep } from "./steps/list-pr.ts";
import {
  promptValidatedMergePrNumber,
  runMergePrStep,
} from "./steps/merge-pr.ts";
import {
  collectEagerWorkflowInputs,
  runWorkflowStep,
  validateRunWorkflowRemote,
} from "./steps/run-workflow.ts";
import { cleanupStaleUpgradeArtifacts, runUpgrade } from "./upgrade.ts";
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
  cleanupStaleUpgradeArtifacts();
  const program = new Command();
  program
    .name("gitrung")
    .description("Run declarative Gitea/GitHub PR + workflow automation steps")
    .option("-r, --repo <label>", "Repo label (configs/<label>.jsonc filename stem)")
    .option("-c, --config <path>", "Path to configs directory")
    .action(async () => {
      const opts = program.opts<{ repo?: string; config?: string }>();
      await runPipeline(opts);
    });

  program
    .command("doctor")
    .description("Parse and validate configs directory")
    .option("-c, --config <path>", "Path to configs directory")
    .action((opts: { config?: string }) => {
      runDoctor(opts.config ?? program.opts<{ config?: string }>().config);
    });

  program
    .command("upgrade")
    .description("Check for and install the latest compiled binary")
    .action(runUpgrade);

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

type EagerLeafContext = {
  leaf: LeafStep;
  key: string;
  index: number;
  fromEagerGroup: boolean;
};

type EagerPreflightMaps = {
  skipped: SkippedStepSet;
  sourceBranches: SourceBranchMap;
  mergePrNumbers: MergePrNumberMap;
};

/** Eager group → selected child; non-eager group → null; top-level leaf → itself. */
function resolveEagerLeafContext(
  step: PipelineStep,
  index: number,
  selectedSubSteps: SelectedSubStepMap,
): EagerLeafContext | null {
  if (isStepGroup(step)) {
    if (!step.eager) return null;
    const subIndex = selectedSubSteps.get(index);
    if (subIndex === undefined) return null;
    return {
      leaf: step.subSteps[subIndex]!,
      key: stepKey(index, subIndex),
      index,
      fromEagerGroup: true,
    };
  }
  return {
    leaf: step,
    key: stepKey(index),
    index,
    fromEagerGroup: false,
  };
}

/** Type-specific eager prompts + immediate remote validation. */
async function runEagerLeafPreflight(
  client: GitHostClient,
  label: string,
  ctx: EagerLeafContext,
  maps: EagerPreflightMaps,
  totalSteps: number,
): Promise<void> {
  const { leaf, key, index, fromEagerGroup } = ctx;

  if (leaf.type === "create-pr") {
    if (!leaf.eager || !leaf.needConfirmation) return;
    const initial = await resolveSourceBranch(label, leaf);
    const result = await confirmCreatePrStep(
      leaf.destinationBranch,
      initial,
      label,
      index,
      totalSteps,
    );
    if (result.action === "skip") {
      maps.skipped.add(index);
      p.log.info(
        `Will skip step ${index + 1}: ${formatStepLabel(leaf, initial)}`,
      );
      return;
    }

    let source = result.sourceBranch;
    while (true) {
      try {
        await validateCreatePrRemote(client, leaf, source);
        maps.sourceBranches.set(key, source);
        return;
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        p.log.error(text);
        const sourceFailed =
          text.includes(`"${source}"`) ||
          text.includes(`Branch "${source}"`) ||
          text.includes(`branch ${source}`);
        if (!sourceFailed) throw err;
        p.log.info("Enter another source branch.");
        source = await promptSourceBranch(source);
        persistSourceBranch(label, leaf.destinationBranch, source);
      }
    }
  }

  if (leaf.type === "run-workflow") {
    if (!leaf.eager || !leaf.needConfirmation) return;
    const ok = await confirmRunWorkflowStep(leaf, index, totalSteps);
    if (!ok) {
      maps.skipped.add(index);
      p.log.info(`Will skip step ${index + 1}: ${formatStepLabel(leaf)}`);
      return;
    }
    await validateRunWorkflowRemote(client, leaf);
    return;
  }

  if (leaf.type === "merge-pr") {
    // Only collect PR# early when chosen under an eager sub-steps group
    if (!fromEagerGroup) return;
    const validated = await promptValidatedMergePrNumber(
      client,
      leaf,
      `Enter PR number for step ${index + 1} (merge-pr)`,
    );
    maps.mergePrNumbers.set(key, validated.pr.number);
    return;
  }

  if (leaf.type === "list-pr") return;

  const _exhaustive: never = leaf;
  throw new Error(`Unknown leaf: ${JSON.stringify(_exhaustive)}`);
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
  const maps: EagerPreflightMaps = {
    skipped,
    sourceBranches,
    mergePrNumbers,
  };

  // Eager groups: pick child first
  for (const [index, step] of steps.entries()) {
    if (!isStepGroup(step) || !step.eager) continue;
    const subIndex = await selectSubStep(step, index, steps.length);
    selectedSubSteps.set(index, subIndex);
  }

  // Ordered confirms / PR# (walker is type-agnostic)
  for (const [index, step] of steps.entries()) {
    if (skipped.has(index)) continue;
    const ctx = resolveEagerLeafContext(step, index, selectedSubSteps);
    if (!ctx) continue;
    await runEagerLeafPreflight(client, label, ctx, maps, steps.length);
  }

  const eagerWorkflowSteps: {
    step: RunWorkflowStep;
    key: string;
    labelHint: string;
  }[] = [];

  for (const [index, step] of steps.entries()) {
    if (skipped.has(index)) continue;
    const ctx = resolveEagerLeafContext(step, index, selectedSubSteps);
    if (!ctx) continue;
    if (ctx.leaf.type !== "run-workflow" || !ctx.leaf.eager) continue;
    eagerWorkflowSteps.push({
      step: ctx.leaf,
      key: ctx.key,
      labelHint: ctx.fromEagerGroup
        ? `step ${index + 1} (sub-step)`
        : `step ${index + 1}`,
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
  const answer = await p.select({
    message: `Run ${chalk.yellow(`[${stepIndex + 1}/${totalSteps}]`)}: ${step.workflow} @ ${step.ref}?`,
    options: [
      { value: "yes", label: "Yes" },
      { value: "skip", label: "Skip" },
    ],
    initialValue: "yes",
  });

  if (p.isCancel(answer)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  return answer === "yes";
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
    `waitUntilFinish=${step.waitUntilFinish}`,
    `exitOnError=${step.exitOnError}`,
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
