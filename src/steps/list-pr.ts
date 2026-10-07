import * as p from "@clack/prompts";
import ora from "ora";
import type { GiteaClient, GiteaPullRequest } from "../gitea.ts";
import type { ListPrStep } from "../schema.ts";

export async function runListPrStep(
  client: GiteaClient,
  step: ListPrStep,
): Promise<void> {
  const filterHint = step.user ? `, author=${step.user}` : "";
  const spinner = ora(`Listing ${step.status} PRs${filterHint}`).start();

  let prs: GiteaPullRequest[];
  try {
    prs = await client.listPullRequests(step.status);
    spinner.succeed(`Fetched ${prs.length} ${step.status} PR(s)`);
  } catch (err) {
    spinner.fail("Failed to list PRs");
    throw err;
  }

  if (step.user) {
    const login = step.user.toLowerCase();
    prs = prs.filter((pr) => pr.user?.login?.toLowerCase() === login);
  }

  if (prs.length === 0) {
    p.log.warn(
      step.user
        ? `No ${step.status} PRs found for author "${step.user}".`
        : `No ${step.status} PRs found.`,
    );
  } else {
    const lines = prs.map(formatPrLine).join("\n");
    p.note(lines, `${prs.length} PR(s)`);
  }
}

function formatPrLine(pr: GiteaPullRequest): string {
  const author = pr.user?.login ?? "?";
  const head = pr.head?.ref ?? "?";
  const base = pr.base?.ref ?? "?";
  return `#${pr.number} ${pr.title}\n  ${author} · ${head} → ${base}\n  ${pr.html_url}`;
}
