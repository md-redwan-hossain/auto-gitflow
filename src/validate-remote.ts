import ora from "ora";
import type { GitHostClient } from "./git-host.ts";

export async function assertBranchExists(
  client: GitHostClient,
  branch: string,
): Promise<void> {
  const spinner = ora(`Checking branch ${branch}…`).start();
  try {
    const ok = await client.branchExists(branch);
    if (!ok) {
      spinner.fail(`Branch not found: ${branch}`);
      throw new Error(
        `Branch "${branch}" does not exist on ${client.owner}/${client.repo}`,
      );
    }
    spinner.succeed(`Branch OK: ${branch}`);
  } catch (err) {
    if (spinner.isSpinning) spinner.fail(`Failed checking branch ${branch}`);
    throw err;
  }
}

export async function assertWorkflowFileExists(
  client: GitHostClient,
  workflowFile: string,
  ref: string,
): Promise<void> {
  const path = `${client.workflowsDir}/${workflowFile}`;
  const spinner = ora(`Checking ${path} @ ${ref}…`).start();
  try {
    await client.getFileContents(path, ref);
    spinner.succeed(`Workflow OK: ${path} @ ${ref}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    spinner.fail(`Workflow not found: ${path} @ ${ref}`);
    if (message.includes("→ 404")) {
      throw new Error(
        `Workflow file "${path}" not found on ref "${ref}" in ${client.owner}/${client.repo}`,
      );
    }
    throw err;
  }
}
