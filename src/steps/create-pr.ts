import * as p from "@clack/prompts";
import ora from "ora";
import type { GitHostClient, WorkflowRun } from "../git-host.ts";
import type { AskYesNo, CreatePrStep } from "../schema.ts";

const POLL_MS = 10_000;
const TIMEOUT_MS = 45 * 60 * 1000;
const MERGE_SKEW_MS = 30_000;

export async function runCreatePrStep(
  client: GitHostClient,
  step: CreatePrStep,
): Promise<void> {
  const title =
    step.title ??
    `Merge ${step.sourceBranch} into ${step.destinationBranch}`;
  const body =
    step.body ??
    `Automated PR: \`${step.sourceBranch}\` → \`${step.destinationBranch}\``;

  const existing = await client.findOpenPullRequest(
    step.sourceBranch,
    step.destinationBranch,
  );
  if (existing) {
    p.log.warn(
      `Open PR already exists: #${existing.number} ${existing.html_url}`,
    );
    p.cancel("Skipped create-pr (PR already exists).");
    process.exit(0);
  }

  const compareSpinner = ora(
    `Comparing ${step.destinationBranch}...${step.sourceBranch}`,
  ).start();
  try {
    const diff = await client.compare(
      step.destinationBranch,
      step.sourceBranch,
    );
    if (diff.total_commits === 0) {
      compareSpinner.warn("Nothing to merge (empty diff)");
      p.log.info(
        `Skipped create-pr: ${step.sourceBranch} has no commits ahead of ${step.destinationBranch}; continuing.`,
      );
      return;
    }
    compareSpinner.succeed(
      `${diff.total_commits} commit(s) ahead of ${step.destinationBranch}`,
    );
  } catch (err) {
    compareSpinner.fail("Failed to compare branches");
    throw err;
  }

  const createSpinner = ora(
    `Creating PR ${step.sourceBranch} → ${step.destinationBranch}`,
  ).start();

  let pr;
  try {
    pr = await client.createPullRequest({
      head: step.sourceBranch,
      base: step.destinationBranch,
      title,
      body,
    });
    createSpinner.succeed(`PR #${pr.number} created: ${pr.html_url}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isDuplicatePrError(message)) {
      createSpinner.warn("PR already exists");
      p.cancel("Skipped create-pr (duplicate PR).");
      process.exit(0);
    }
    createSpinner.fail("Failed to create PR");
    throw err;
  }

  const mergeWhenChecksSucceed = await resolveMergeWhenChecksSucceed(
    step.mergeWhenChecksSucceed,
  );

  const mergeSpinner = ora(
    mergeWhenChecksSucceed
      ? `Scheduling merge of PR #${pr.number} when checks pass`
      : `Merging PR #${pr.number} now`,
  ).start();

  try {
    await client.mergePullRequest(pr.number, { mergeWhenChecksSucceed });
    mergeSpinner.succeed(
      mergeWhenChecksSucceed
        ? `PR #${pr.number} will merge when all checks pass`
        : `PR #${pr.number} merge requested`,
    );
  } catch (err) {
    mergeSpinner.fail(`Failed to merge PR #${pr.number}`);
    throw err;
  }

  const mergedAt = await waitForPrMerged(client, pr.number);

  for (const workflow of step.waitFor) {
    await waitForWorkflowSuccess(
      client,
      workflow,
      step.destinationBranch,
      mergedAt,
    );
  }
}

async function waitForPrMerged(
  client: GitHostClient,
  prNumber: number,
): Promise<Date> {
  const spinner = ora(`Waiting for PR #${prNumber} to merge…`).start();
  const deadline = Date.now() + TIMEOUT_MS;

  try {
    while (Date.now() < deadline) {
      const pr = await client.getPullRequest(prNumber);
      if (pr.merged) {
        const mergedAt = pr.merged_at
          ? new Date(pr.merged_at)
          : new Date();
        spinner.succeed(`PR #${prNumber} merged`);
        return mergedAt;
      }
      spinner.text = `Waiting for PR #${prNumber} to merge… (state=${pr.state})`;
      await sleep(POLL_MS);
    }
    spinner.fail(`Timed out waiting for PR #${prNumber} to merge`);
    throw new Error(
      `PR #${prNumber} did not merge within ${TIMEOUT_MS / 60_000} minutes`,
    );
  } catch (err) {
    if (spinner.isSpinning) spinner.fail(`Failed waiting for PR #${prNumber}`);
    throw err;
  }
}

async function waitForWorkflowSuccess(
  client: GitHostClient,
  workflowFile: string,
  destinationBranch: string,
  mergedAt: Date,
): Promise<void> {
  const spinner = ora(`Waiting for ${workflowFile}…`).start();
  const deadline = Date.now() + TIMEOUT_MS;
  const earliest = mergedAt.getTime() - MERGE_SKEW_MS;
  let loggedOnce = false;

  try {
    while (Date.now() < deadline) {
      const runs = await client.listWorkflowRuns(workflowFile);
      const candidate = pickPostMergeRun(runs, destinationBranch, earliest);

      if (!candidate) {
        if (runs.length > 0) {
          spinner.text = `Waiting for ${workflowFile} (${runs.length} run(s) listed, matching post-merge…)…`;
          if (!loggedOnce) {
            const newest = runs[0];
            p.log.info(
              `${workflowFile}: listed ${runs.length} run(s); newest #${newest?.id} status=${newest?.status} conclusion=${newest?.conclusion} event=${newest?.event} head_branch=${newest?.head_branch}`,
            );
            loggedOnce = true;
          }
        } else {
          spinner.text = `Waiting for ${workflowFile} to start…`;
        }
        await sleep(POLL_MS);
        continue;
      }

      const outcome = classifyRun(candidate);
      if (outcome === "pending") {
        spinner.text = `Waiting for ${workflowFile} (run #${candidate.id}, status=${candidate.status ?? "?"}, conclusion=${candidate.conclusion ?? "—"})…`;
        await sleep(POLL_MS);
        continue;
      }
      if (outcome === "failed") {
        spinner.fail(
          `${workflowFile} failed (run #${candidate.id}${candidate.html_url ? `: ${candidate.html_url}` : ""})`,
        );
        throw new Error(
          `Workflow ${workflowFile} ended with status=${candidate.status} conclusion=${candidate.conclusion}`,
        );
      }

      spinner.succeed(`${workflowFile} succeeded (run #${candidate.id})`);
      return;
    }

    spinner.fail(`Timed out waiting for ${workflowFile}`);
    throw new Error(
      `${workflowFile} did not succeed within ${TIMEOUT_MS / 60_000} minutes`,
    );
  } catch (err) {
    if (spinner.isSpinning) spinner.fail(`Failed waiting for ${workflowFile}`);
    throw err;
  }
}

function pickPostMergeRun(
  runs: WorkflowRun[],
  destinationBranch: string,
  earliestMs: number,
): WorkflowRun | undefined {
  const branchOk = (run: WorkflowRun): boolean =>
    !run.head_branch ||
    run.head_branch === destinationBranch ||
    run.head_branch === `refs/heads/${destinationBranch}`;

  const strict = runs.filter((run) => {
    const started = runTimeMs(run);
    if (started === undefined || started < earliestMs) return false;
    return branchOk(run);
  });

  if (strict.length > 0) {
    strict.sort((a, b) => (runTimeMs(b) ?? 0) - (runTimeMs(a) ?? 0));
    return strict[0];
  }

  // Fallback: newest run on destination branch (or unset branch), no timestamp required
  const fallback = runs.filter(branchOk);
  if (fallback.length === 0) return undefined;
  fallback.sort((a, b) => (runTimeMs(b) ?? 0) - (runTimeMs(a) ?? 0));
  return fallback[0];
}

function runTimeMs(run: WorkflowRun): number | undefined {
  const raw = run.run_started_at ?? run.created_at ?? run.updated_at;
  if (!raw) return undefined;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? undefined : ms;
}

function classifyRun(
  run: WorkflowRun,
): "pending" | "success" | "failed" {
  const status = (run.status ?? "").toLowerCase();
  const conclusion = (run.conclusion ?? "").toLowerCase();

  if (
    status === "success" ||
    conclusion === "success" ||
    (status === "completed" && conclusion === "success")
  ) {
    return "success";
  }

  if (
    ["failure", "failed", "cancelled", "canceled", "timed_out", "action_required"].includes(
      status,
    ) ||
    ["failure", "failed", "cancelled", "canceled", "timed_out", "action_required", "startup_failure"].includes(
      conclusion,
    )
  ) {
    return "failed";
  }

  if (
    ["queued", "waiting", "requested", "pending", "in_progress", "running"].includes(
      status,
    )
  ) {
    return "pending";
  }

  if (
    status === "completed" &&
    (conclusion === "" || conclusion === "null")
  ) {
    return "pending";
  }

  if (status === "completed") {
    return conclusion === "success" ? "success" : "failed";
  }

  // Gitea UI sometimes surfaces only conclusion
  if (conclusion === "success") return "success";

  return "pending";
}

async function resolveMergeWhenChecksSucceed(
  value: AskYesNo,
): Promise<boolean> {
  if (value === "yes") return true;
  if (value === "no") return false;

  const answer = await p.confirm({
    message: "Merge automatically when all checks pass?",
    initialValue: true,
  });

  if (p.isCancel(answer)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  return answer;
}

function isDuplicatePrError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("→ 409") ||
    lower.includes("pull request already exists") ||
    lower.includes("already exists")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
