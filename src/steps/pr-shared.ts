import * as p from "@clack/prompts";
import { normalizeRef, type GitHostClient, type WorkflowRun } from "../git-host.ts";
import type { AskYesNo } from "../schema.ts";
import { createSpinner } from "../spinner.ts";

export const POLL_MS = 10_000;
export const TIMEOUT_MS = 45 * 60 * 1000;
export const MERGEABLE_TIMEOUT_MS = 3 * 60 * 1000;
export const MERGE_SKEW_MS = 30_000;

export async function waitForPrMerged(
  client: GitHostClient,
  prNumber: number,
): Promise<Date> {
  const spinner = createSpinner(`Waiting for PR #${prNumber} to merge…`).start();
  const deadline = Date.now() + TIMEOUT_MS;

  try {
    while (Date.now() < deadline) {
      const pr = await client.getPullRequest(prNumber);
      if (pr.merged) {
        const mergedAt = pr.merged_at
          ? new Date(pr.merged_at)
          : new Date();
        spinner.succeedSuccess(`PR #${prNumber} merged`);
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

export async function waitForWorkflowSuccess(
  client: GitHostClient,
  workflowFile: string,
  destinationBranch: string,
  mergedAt: Date,
): Promise<void> {
  const spinner = createSpinner(`Waiting for ${workflowFile}…`).start();
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

      spinner.succeedSuccess(
        `${workflowFile} succeeded (run #${candidate.id})`,
      );
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

export async function assertPrMergeable(
  client: GitHostClient,
  prNumber: number,
): Promise<void> {
  const spinner = createSpinner(
    `Checking mergeability of PR #${prNumber}…`,
  ).start();
  const deadline = Date.now() + MERGEABLE_TIMEOUT_MS;

  try {
    while (Date.now() < deadline) {
      const pr = await client.getPullRequest(prNumber);

      if (pr.merged) {
        spinner.fail(`PR #${prNumber} is already merged`);
        throw new Error(`PR #${prNumber} is already merged`);
      }

      const state = (pr.state ?? "").toLowerCase();
      if (state === "closed") {
        spinner.fail(`PR #${prNumber} is already closed`);
        throw new Error(`PR #${prNumber} is already closed`);
      }

      if (pr.mergeable === null || pr.mergeable === undefined) {
        spinner.text = `Checking mergeability of PR #${prNumber}… (computing)`;
        await sleep(POLL_MS);
        continue;
      }

      if (pr.mergeable === false) {
        spinner.fail(`PR #${prNumber} has merge conflicts`);
        throw new Error(
          `PR #${prNumber} has merge conflicts and cannot be merged`,
        );
      }

      spinner.succeedInfo(`PR #${prNumber} is mergeable`);
      return;
    }

    spinner.fail(`Timed out waiting for mergeability of PR #${prNumber}`);
    throw new Error(
      `PR #${prNumber} mergeability was not computed within ${MERGEABLE_TIMEOUT_MS / 60_000} minutes`,
    );
  } catch (err) {
    if (spinner.isSpinning) {
      spinner.fail(`Failed checking mergeability of PR #${prNumber}`);
    }
    throw err;
  }
}

/** Wait until commit checks are no longer pending; fail on failure/error. */
export async function waitForPrChecks(
  client: GitHostClient,
  prNumber: number,
): Promise<void> {
  const pr = await client.getPullRequest(prNumber);
  const sha = typeof pr.head?.sha === "string" ? pr.head.sha : undefined;
  if (!sha) {
    p.log.warn(
      `PR #${prNumber} has no head SHA; skipping check wait and proceeding to merge`,
    );
    return;
  }

  const spinner = createSpinner(
    `Waiting for checks on PR #${prNumber}…`,
  ).start();
  const deadline = Date.now() + TIMEOUT_MS;

  try {
    while (Date.now() < deadline) {
      const status = await client.getCommitStatus(sha);
      const state = (status.state ?? "").toLowerCase();
      const total = status.total_count ?? 0;

      if (total === 0 || state === "" || state === "success") {
        spinner.succeedInfo(
          total === 0
            ? `No checks on PR #${prNumber}; proceeding`
            : `Checks passed on PR #${prNumber}`,
        );
        return;
      }

      if (
        state === "failure" ||
        state === "error" ||
        state === "failed"
      ) {
        spinner.fail(`Checks failed on PR #${prNumber} (state=${state})`);
        throw new Error(
          `PR #${prNumber} checks finished with state=${state}`,
        );
      }

      // pending / warning / unknown → keep waiting
      spinner.text = `Waiting for checks on PR #${prNumber}… (state=${state}, count=${total})`;
      await sleep(POLL_MS);
    }

    spinner.fail(`Timed out waiting for checks on PR #${prNumber}`);
    throw new Error(
      `PR #${prNumber} checks did not finish within ${TIMEOUT_MS / 60_000} minutes`,
    );
  } catch (err) {
    if (spinner.isSpinning) {
      spinner.fail(`Failed waiting for checks on PR #${prNumber}`);
    }
    throw err;
  }
}

export async function resolveMergeWhenChecksSucceed(
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

export function matchWhenWaitFor(
  when: { destinationBranch: string; waitFor: string[] }[],
  baseRef: string | undefined,
): { destinationBranch: string; waitFor: string[] } | undefined {
  if (!baseRef || when.length === 0) return undefined;
  const base = normalizeRef(baseRef);
  return when.find(
    (entry) => normalizeRef(entry.destinationBranch) === base,
  );
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

  if (conclusion === "success") return "success";

  return "pending";
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
