import { parse, stringify } from "comment-json";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ZodError } from "zod";
import { projectRoot } from "./load-config.ts";
import {
  formatZodError,
  HistoryFileSchema,
  type HistoryFile,
  type RepoHistory,
  type WorkflowHistoryEntry,
  type WorkflowInputValues,
} from "./schema.ts";

const MAX_LAST_USED = 5;

function historyPath(): string {
  return resolve(projectRoot(), "history.jsonc");
}

export function loadHistory(): HistoryFile {
  const path = historyPath();
  if (!existsSync(path)) {
    return { repos: [] };
  }
  const raw = readFileSync(path, "utf8");
  const data = parse(raw);
  try {
    return HistoryFileSchema.parse(data);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new Error(`Invalid history.jsonc:\n${formatZodError(err)}`);
    }
    throw err;
  }
}

export function saveHistory(history: HistoryFile): void {
  const body = stringify(history, null, 2);
  const content = `// Auto-updated by gitea-automation. Do not commit.\n${body}\n`;
  writeFileSync(historyPath(), content, "utf8");
}

export function getLatestWorkflowInputs(
  history: HistoryFile,
  repoUrl: string,
  workflowName: string,
): WorkflowInputValues | undefined {
  const repo = findRepo(history, repoUrl);
  const workflow = repo?.workflows.find((w) => w.name === workflowName);
  return workflow?.lastUsed[0];
}

export function recordWorkflowInputs(
  history: HistoryFile,
  repoUrl: string,
  workflowName: string,
  inputs: WorkflowInputValues,
): HistoryFile {
  const repo = ensureRepo(history, repoUrl);

  let workflow = repo.workflows.find((w) => w.name === workflowName);
  if (!workflow) {
    workflow = { name: workflowName, lastUsed: [] };
    repo.workflows.push(workflow);
  }

  workflow.lastUsed = [
    cloneInputs(inputs),
    ...workflow.lastUsed.filter((entry) => !shallowEqual(entry, inputs)),
  ].slice(0, MAX_LAST_USED);

  return history;
}

export function getSourceBranch(
  history: HistoryFile,
  repoUrl: string,
): string | undefined {
  return findRepo(history, repoUrl)?.sourceBranch;
}

/** Overwrites the single last source branch for this repo. */
export function setSourceBranch(
  history: HistoryFile,
  repoUrl: string,
  sourceBranch: string,
): HistoryFile {
  const repo = ensureRepo(history, repoUrl);
  repo.sourceBranch = sourceBranch;
  return history;
}

function findRepo(
  history: HistoryFile,
  repoUrl: string,
): RepoHistory | undefined {
  return history.repos.find((r) => r.repoUrl === repoUrl);
}

function ensureRepo(history: HistoryFile, repoUrl: string): RepoHistory {
  let repo = findRepo(history, repoUrl);
  if (!repo) {
    repo = { repoUrl, workflows: [] };
    history.repos.push(repo);
  }
  return repo;
}

function cloneInputs(inputs: WorkflowInputValues): WorkflowInputValues {
  return { ...inputs };
}

function shallowEqual(
  a: WorkflowInputValues,
  b: WorkflowInputValues,
): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => a[key] === b[key]);
}

export function formatInputsSummary(inputs: WorkflowInputValues): string {
  return Object.entries(inputs)
    .map(([k, v]) => `  ${k}: ${String(v)}`)
    .join("\n");
}

export type { WorkflowHistoryEntry };
