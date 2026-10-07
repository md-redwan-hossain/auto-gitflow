import * as p from "@clack/prompts";
import type { GitHostClient } from "../git-host.ts";
import type { CreatePrStep } from "../schema.ts";
import { createSpinner } from "../spinner.ts";
import {
  assertBranchExists,
  assertWorkflowFileExists,
} from "../validate-remote.ts";
import {
  assertPrMergeable,
  resolveMergeWhenChecksSucceed,
  waitForPrMerged,
  waitForWorkflowSuccess,
} from "./pr-shared.ts";

export async function runCreatePrStep(
  client: GitHostClient,
  step: CreatePrStep,
  opts: { sourceBranch: string },
): Promise<void> {
  const sourceBranch = opts.sourceBranch;
  const title =
    step.title ?? `Merge ${sourceBranch} into ${step.destinationBranch}`;
  const body =
    step.body ??
    `Automated PR: \`${sourceBranch}\` → \`${step.destinationBranch}\``;

  await assertBranchExists(client, sourceBranch);
  await assertBranchExists(client, step.destinationBranch);
  for (const workflow of step.waitFor) {
    await assertWorkflowFileExists(
      client,
      workflow,
      step.destinationBranch,
    );
  }

  const existing = await client.findOpenPullRequest(
    sourceBranch,
    step.destinationBranch,
  );
  if (existing) {
    p.log.warn(
      `Open PR already exists: #${existing.number} ${existing.html_url}`,
    );
    p.cancel("Skipped create-pr (PR already exists).");
    process.exit(0);
  }

  const compareSpinner = createSpinner(
    `Comparing ${step.destinationBranch}...${sourceBranch}`,
  ).start();
  try {
    const diff = await client.compare(
      step.destinationBranch,
      sourceBranch,
    );
    if (diff.total_commits === 0) {
      compareSpinner.warn("Nothing to merge (empty diff)");
      p.log.info(
        `Skipped create-pr: ${sourceBranch} has no commits ahead of ${step.destinationBranch}; continuing.`,
      );
      return;
    }
    compareSpinner.succeedInfo(
      `${diff.total_commits} commit(s) ahead of ${step.destinationBranch}`,
    );
  } catch (err) {
    compareSpinner.fail("Failed to compare branches");
    throw err;
  }

  const createPrSpinner = createSpinner(
    `Creating PR ${sourceBranch} → ${step.destinationBranch}`,
  ).start();

  let pr;
  try {
    pr = await client.createPullRequest({
      head: sourceBranch,
      base: step.destinationBranch,
      title,
      body,
    });
    createPrSpinner.succeedInfo(`PR #${pr.number} created: ${pr.html_url}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (isDuplicatePrError(message)) {
      createPrSpinner.warn("PR already exists");
      p.cancel("Skipped create-pr (duplicate PR).");
      process.exit(0);
    }
    createPrSpinner.fail("Failed to create PR");
    throw err;
  }

  await assertPrMergeable(client, pr.number);

  const mergeWhenChecksSucceed = await resolveMergeWhenChecksSucceed(
    step.mergeWhenChecksSucceed,
  );

  const mergeSpinner = createSpinner(
    mergeWhenChecksSucceed
      ? `Scheduling merge of PR #${pr.number} when checks pass`
      : `Merging PR #${pr.number} now`,
  ).start();

  try {
    await client.mergePullRequest(pr.number, { mergeWhenChecksSucceed });
    mergeSpinner.succeedInfo(
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

function isDuplicatePrError(message: string): boolean {
  const lower = message.toLowerCase();
  return (
    lower.includes("→ 409") ||
    lower.includes("pull request already exists") ||
    lower.includes("already exists")
  );
}
