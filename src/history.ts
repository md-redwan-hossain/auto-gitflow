import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ZodError } from "zod";
import { projectRoot } from "./load-config.ts";
import {
  formatZodError,
  HistoryFileSchema,
  type HistoryFile,
  type WorkflowHistoryEntry,
  type WorkflowInputValues,
} from "./schema.ts";

const MAX_LAST_USED = 5;

function historyPath(): string {
  return resolve(projectRoot(), "history.jsonc");
}

export function sourceBranchKey(
  label: string,
  destinationBranch: string,
): string {
  return `${label}:create-pr:${destinationBranch}`;
}

export function loadHistory(): HistoryFile {
  const path = historyPath();
  if (!existsSync(path)) {
    return { workflowLogs: {}, sourceBranches: {} };
  }
  const raw = readFileSync(path, "utf8");
  const data = Bun.JSONC.parse(raw);
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
  const body = JSON.stringify(history, null, 2);
  const content = `// Auto-updated by gitrung.\n${body}\n`;
  writeFileSync(historyPath(), content, "utf8");
}

export function getLatestWorkflowInputs(
  history: HistoryFile,
  label: string,
  workflowName: string,
): WorkflowInputValues | undefined {
  const workflows = history.workflowLogs[label];
  const workflow = workflows?.find((w) => w.name === workflowName);
  return workflow?.lastUsed[0];
}

export function recordWorkflowInputs(
  history: HistoryFile,
  label: string,
  workflowName: string,
  inputs: WorkflowInputValues,
): HistoryFile {
  let workflows = history.workflowLogs[label];
  if (!workflows) {
    workflows = [];
    history.workflowLogs[label] = workflows;
  }

  let workflow: WorkflowHistoryEntry | undefined = workflows.find(
    (w) => w.name === workflowName,
  );
  if (!workflow) {
    workflow = { name: workflowName, lastUsed: [] };
    workflows.push(workflow);
  }

  workflow.lastUsed = [
    cloneInputs(inputs),
    ...workflow.lastUsed.filter((entry) => !shallowEqual(entry, inputs)),
  ].slice(0, MAX_LAST_USED);

  return history;
}

export function getSourceBranch(
  history: HistoryFile,
  label: string,
  destinationBranch: string,
): string | undefined {
  return history.sourceBranches[sourceBranchKey(label, destinationBranch)];
}

/** Overwrites the single last source branch for this label + destination. */
export function setSourceBranch(
  history: HistoryFile,
  label: string,
  destinationBranch: string,
  sourceBranch: string,
): HistoryFile {
  history.sourceBranches[sourceBranchKey(label, destinationBranch)] =
    sourceBranch;
  return history;
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
