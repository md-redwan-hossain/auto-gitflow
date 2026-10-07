import * as p from "@clack/prompts";
import type { GitHostClient } from "../git-host.ts";
import type { MergePrStep } from "../schema.ts";
import { createSpinner } from "../spinner.ts";
import {
  assertWorkflowFileExists,
} from "../validate-remote.ts";
import {
  assertPrMergeable,
  matchWhenWaitFor,
  waitForPrChecks,
  waitForPrMerged,
  waitForWorkflowSuccess,
} from "./pr-shared.ts";

export async function promptMergePrNumber(
  message = "Enter PR number to merge",
): Promise<number> {
  const raw = await p.text({
    message,
    validate: (value) => {
      const trimmed = (value ?? "").trim();
      if (!/^\d+$/.test(trimmed) || Number(trimmed) <= 0) {
        return "Enter a positive integer PR number";
      }
    },
  });

  if (p.isCancel(raw)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  return Number(raw.trim());
}

export async function runMergePrStep(
  client: GitHostClient,
  step: MergePrStep,
  opts?: { prNumber?: number },
): Promise<void> {
  const prNumber =
    opts?.prNumber !== undefined
      ? opts.prNumber
      : await promptMergePrNumber();

  let pr;
  try {
    pr = await client.getPullRequest(prNumber);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("→ 404")) {
      throw new Error(`PR #${prNumber} does not exist`);
    }
    throw err;
  }

  if (pr.merged) {
    throw new Error(`PR #${prNumber} is already merged`);
  }

  const state = (pr.state ?? "").toLowerCase();
  if (state === "closed") {
    throw new Error(`PR #${prNumber} is already closed`);
  }

  if (state !== "open") {
    throw new Error(
      `PR #${prNumber} is not open (state=${pr.state ?? "unknown"})`,
    );
  }

  p.log.info(
    `PR #${pr.number}: ${pr.title} (${pr.head?.ref ?? "?"} → ${pr.base?.ref ?? "?"}) ${pr.html_url}`,
  );

  const matched = matchWhenWaitFor(step.when, pr.base?.ref);
  const waitFor = matched?.waitFor ?? [];
  const destinationBranch =
    matched?.destinationBranch ?? pr.base?.ref ?? "";

  if (matched) {
    p.log.info(
      `when matched destination=${matched.destinationBranch}; waitFor=${matched.waitFor.join(",")}`,
    );
    for (const workflow of waitFor) {
      await assertWorkflowFileExists(
        client,
        workflow,
        matched.destinationBranch,
      );
    }
  } else if (step.when.length > 0) {
    p.log.info(
      `No when entry for base=${pr.base?.ref ?? "—"}; skipping post-merge workflow waits`,
    );
  }

  await assertPrMergeable(client, pr.number);
  await waitForPrChecks(client, pr.number);

  const mergeSpinner = createSpinner(`Merging PR #${pr.number} now`).start();
  try {
    await client.mergePullRequest(pr.number, {
      mergeWhenChecksSucceed: false,
    });
    mergeSpinner.succeedInfo(`PR #${pr.number} merge requested`);
  } catch (err) {
    mergeSpinner.fail(`Failed to merge PR #${pr.number}`);
    throw err;
  }

  const mergedAt = await waitForPrMerged(client, pr.number);

  for (const workflow of waitFor) {
    await waitForWorkflowSuccess(
      client,
      workflow,
      destinationBranch,
      mergedAt,
    );
  }
}
