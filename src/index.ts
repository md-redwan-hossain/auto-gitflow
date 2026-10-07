#!/usr/bin/env bun
import * as p from "@clack/prompts";
import { Command } from "commander";
import { createGitClient } from "./create-git-client.ts";
import { runDoctor } from "./doctor.ts";
import type { GitHostClient } from "./git-host.ts";
import { loadConfig, loadToken } from "./load-config.ts";
import { parseRepoUrl } from "./parse-repo-url.ts";
import { runCreatePrStep } from "./steps/create-pr.ts";
import { runListPrStep } from "./steps/list-pr.ts";
import {
  collectEagerWorkflowInputs,
  runWorkflowStep,
} from "./steps/run-workflow.ts";
import type {
  EagerInputMap,
  RepoConfig,
  RunWorkflowStep,
  SkippedStepSet,
  Step,
} from "./schema.ts";

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("gitea-automation")
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
  p.intro("gitea-automation");

  const config = loadConfig(opts.config);

  const repo = await pickRepo(config.repos, opts.repo);
  const token = loadToken(repo.gitPlatform);
  const parsed = parseRepoUrl(repo.url, repo.gitPlatform);
  const client = createGitClient(parsed, token);

  p.log.info(
    `Repo: ${repo.label} (${parsed.owner}/${parsed.repo}) [${repo.gitPlatform}]`,
  );
  p.log.info(`${repo.steps.length} step(s)`);

  const { eagerInputs, skipped } = await runEagerPreflight(client, repo.steps);

  for (const [index, step] of repo.steps.entries()) {
    p.log.step(`[${index + 1}/${repo.steps.length}] ${describeStep(step)}`);
    await runStep(client, step, index, eagerInputs, skipped);
  }

  p.outro("Done.");
}

async function runEagerPreflight(
  client: GitHostClient,
  steps: Step[],
): Promise<{ eagerInputs: EagerInputMap; skipped: SkippedStepSet }> {
  const skipped: SkippedStepSet = new Set();

  for (const [index, step] of steps.entries()) {
    if (
      (step.type !== "create-pr" && step.type !== "run-workflow") ||
      !step.eager ||
      !step.needConfirmation
    ) {
      continue;
    }

    const ok = await confirmStep(step, { eager: true });
    if (!ok) {
      skipped.add(index);
      p.log.info(`Will skip step ${index + 1}: ${describeStep(step)}`);
    }
  }

  const eagerWorkflowSteps: { step: RunWorkflowStep; index: number }[] = [];
  for (const [index, step] of steps.entries()) {
    if (step.type !== "run-workflow" || !step.eager) continue;
    if (skipped.has(index)) continue;
    eagerWorkflowSteps.push({ step, index });
  }

  if (eagerWorkflowSteps.length === 0) {
    return { eagerInputs: new Map(), skipped };
  }

  p.log.info(
    `Collecting eager inputs for ${eagerWorkflowSteps.length} workflow(s)…`,
  );
  const eagerInputs = await collectEagerWorkflowInputs(
    client,
    eagerWorkflowSteps,
  );
  return { eagerInputs, skipped };
}

async function confirmStep(
  step: Step,
  _meta: { eager: boolean },
): Promise<boolean> {
  // Fresh confirm every run — never from history
  let message: string;
  if (step.type === "create-pr") {
    message = `Run create-pr ${step.sourceBranch} → ${step.destinationBranch}?`;
  } else if (step.type === "run-workflow") {
    message = `Run workflow ${step.workflow} @ ${step.ref}?`;
  } else {
    return true;
  }

  const answer = await p.confirm({
    message,
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

function describeStep(step: Step): string {
  if (step.type === "create-pr") {
    const flags = [
      `mergeWhenChecksSucceed=${step.mergeWhenChecksSucceed}`,
      `waitFor=${step.waitFor.join(",") || "—"}`,
      `eager=${step.eager}`,
      `needConfirmation=${step.needConfirmation}`,
    ];
    return `create-pr ${step.sourceBranch} → ${step.destinationBranch} (${flags.join(", ")})`;
  }
  if (step.type === "list-pr") {
    const user = step.user ? `, user=${step.user}` : "";
    return `list-pr status=${step.status}${user}`;
  }
  return `run-workflow ${step.workflow} @ ${step.ref} (eager=${step.eager}, needConfirmation=${step.needConfirmation})`;
}

async function runStep(
  client: GitHostClient,
  step: Step,
  stepIndex: number,
  eagerInputs: EagerInputMap,
  skipped: SkippedStepSet,
): Promise<void> {
  if (skipped.has(stepIndex)) {
    p.log.info(`Skipped (declined earlier): ${describeStep(step)}`);
    return;
  }

  if (
    (step.type === "create-pr" || step.type === "run-workflow") &&
    step.needConfirmation &&
    !step.eager
  ) {
    const ok = await confirmStep(step, { eager: false });
    if (!ok) {
      p.log.info(`Skipped: ${describeStep(step)}`);
      return;
    }
  }

  if (step.type === "create-pr") {
    await runCreatePrStep(client, step);
    return;
  }
  if (step.type === "run-workflow") {
    await runWorkflowStep(client, step, { stepIndex, eagerInputs });
    return;
  }
  if (step.type === "list-pr") {
    await runListPrStep(client, step);
    return;
  }
  const _exhaustive: never = step;
  throw new Error(`Unknown step: ${JSON.stringify(_exhaustive)}`);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  p.log.error(message);
  process.exit(1);
});
