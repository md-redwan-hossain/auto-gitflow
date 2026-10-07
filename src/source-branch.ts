import * as p from "@clack/prompts";
import {
  getSourceBranch,
  loadHistory,
  saveHistory,
  setSourceBranch,
} from "./history.ts";
import type { CreatePrStep } from "./schema.ts";

/**
 * Resolve create-pr source branch: config → history → prompt.
 * Saves to history when the user chooses/enters a value (not when taken from config as-is).
 */
export async function resolveSourceBranch(
  repoUrl: string,
  step: CreatePrStep,
): Promise<string> {
  if (step.sourceBranch) {
    return step.sourceBranch;
  }

  const history = loadHistory();
  const last = getSourceBranch(history, repoUrl);

  if (last) {
    p.note(last, "Last source branch");
    const reuse = await p.confirm({
      message: "Use source branch from history?",
      initialValue: true,
    });
    if (p.isCancel(reuse)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }
    if (reuse) {
      return last;
    }
  }

  const entered = await promptSourceBranch(last);
  persistSourceBranch(repoUrl, entered);
  return entered;
}

export async function promptSourceBranch(
  initial?: string,
): Promise<string> {
  const value = await p.text({
    message: "Source branch",
    placeholder: initial ?? "feature-branch",
    initialValue: initial,
    validate: (v) => {
      if (!v || !v.trim()) return "Source branch is required";
      return undefined;
    },
  });

  if (p.isCancel(value)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }

  return value.trim();
}

export function persistSourceBranch(repoUrl: string, sourceBranch: string): void {
  const history = loadHistory();
  setSourceBranch(history, repoUrl, sourceBranch);
  saveHistory(history);
}

export type CreatePrConfirmResult =
  | { action: "run"; sourceBranch: string }
  | { action: "skip" };

/**
 * Yes / Skip / Change source branch. Does not read confirm choice from history.
 */
export async function confirmCreatePrStep(
  destinationBranch: string,
  sourceBranch: string,
  repoUrl: string,
): Promise<CreatePrConfirmResult> {
  let current = sourceBranch;

  while (true) {
    const choice = await p.select({
      message: `Run create-pr ${current} → ${destinationBranch}?`,
      options: [
        { value: "yes", label: "Yes" },
        { value: "skip", label: "Skip" },
        { value: "change", label: "Change source branch" },
      ],
    });

    if (p.isCancel(choice)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }

    if (choice === "yes") {
      return { action: "run", sourceBranch: current };
    }
    if (choice === "skip") {
      return { action: "skip" };
    }

    current = await promptSourceBranch(current);
    persistSourceBranch(repoUrl, current);
  }
}
