import * as p from "@clack/prompts";
import {
  formatInputsSummary,
  getLatestWorkflowInputs,
  loadHistory,
  recordWorkflowInputs,
  saveHistory,
} from "../history.ts";
import {
  toDispatchInputs,
  type GitHostClient,
} from "../git-host.ts";
import { createSpinner } from "../spinner.ts";
import {
  assertBranchExists,
  assertWorkflowFileExists,
} from "../validate-remote.ts";
import {
  parseWorkflowDispatchInputs,
  promptWorkflowInputs,
} from "../workflow-inputs.ts";
import type {
  EagerInputMap,
  RunWorkflowStep,
  WorkflowInputValues,
} from "../schema.ts";

export async function collectEagerWorkflowInputs(
  client: GitHostClient,
  label: string,
  steps: { step: RunWorkflowStep; key: string; labelHint?: string }[],
): Promise<EagerInputMap> {
  const map: EagerInputMap = new Map();

  for (const { step, key, labelHint } of steps) {
    p.log.step(`Eager inputs: ${step.workflow} @ ${step.ref}`);
    await validateRunWorkflowRemote(client, step);
    const inputs = await resolveWorkflowInputs(client, label, step);
    map.set(key, inputs);
    if (Object.keys(inputs).length > 0) {
      const history = loadHistory();
      recordWorkflowInputs(history, label, step.workflow, inputs);
      saveHistory(history);
      p.note(
        formatInputsSummary(inputs),
        `Recorded in history for ${labelHint ?? `step ${key}`}`,
      );
    }
  }

  return map;
}

export async function runWorkflowStep(
  client: GitHostClient,
  label: string,
  step: RunWorkflowStep,
  opts?: { stepKey?: string; eagerInputs?: EagerInputMap },
): Promise<void> {
  const precollected =
    opts?.stepKey !== undefined
      ? opts.eagerInputs?.get(opts.stepKey)
      : undefined;

  let inputs: WorkflowInputValues;

  if (precollected !== undefined) {
    // Already validated during eager collection
    inputs = precollected;
    p.log.info(
      Object.keys(inputs).length === 0
        ? `Using eager inputs for ${step.workflow} (none).`
        : `Using eager inputs for ${step.workflow}:\n${formatInputsSummary(inputs)}`,
    );
  } else {
    await validateRunWorkflowRemote(client, step);
    inputs = await resolveWorkflowInputs(client, label, step);
  }

  const dispatchSpinner = createSpinner(
    `Dispatching ${step.workflow} on ${step.ref}`,
  ).start();

  try {
    await client.dispatchWorkflow(
      step.workflow,
      step.ref,
      toDispatchInputs(inputs),
    );
    dispatchSpinner.succeedSuccess(`Dispatched ${step.workflow}`);
  } catch (err) {
    dispatchSpinner.fail(`Failed to dispatch ${step.workflow}`);
    throw err;
  }

  if (Object.keys(inputs).length > 0) {
    const history = loadHistory();
    recordWorkflowInputs(history, label, step.workflow, inputs);
    saveHistory(history);
  }
}

export async function validateRunWorkflowRemote(
  client: GitHostClient,
  step: RunWorkflowStep,
): Promise<void> {
  await assertBranchExists(client, step.ref);
  await assertWorkflowFileExists(client, step.workflow, step.ref);
}

export async function resolveWorkflowInputs(
  client: GitHostClient,
  label: string,
  step: RunWorkflowStep,
): Promise<WorkflowInputValues> {
  const workflowPath = `${client.workflowsDir}/${step.workflow}`;
  const fetchSpinner = createSpinner(
    `Fetching ${workflowPath} @ ${step.ref}`,
  ).start();

  let yamlText: string;
  try {
    yamlText = await client.getFileContents(workflowPath, step.ref);
    fetchSpinner.succeedInfo(`Loaded ${step.workflow}`);
  } catch (err) {
    fetchSpinner.fail(`Failed to fetch ${workflowPath}`);
    throw err;
  }

  const inputDefs = parseWorkflowDispatchInputs(yamlText);

  if (Object.keys(inputDefs).length === 0) {
    p.log.info("Workflow has no dispatch inputs.");
    return {};
  }

  return resolveInteractiveInputs(label, step.workflow, inputDefs);
}

async function resolveInteractiveInputs(
  label: string,
  workflowName: string,
  inputDefs: Record<
    string,
    {
      description?: string;
      required?: boolean;
      default?: string | boolean | number;
      type?: string;
      options?: string[];
    }
  >,
): Promise<WorkflowInputValues> {
  const history = loadHistory();
  const latest = getLatestWorkflowInputs(history, label, workflowName);

  if (latest && Object.keys(latest).length > 0) {
    p.note(formatInputsSummary(latest), "Last used inputs");
    const reuse = await p.confirm({
      message: "Use inputs from history?",
      initialValue: true,
    });
    if (p.isCancel(reuse)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }
    if (reuse) {
      return { ...latest };
    }
  }

  return promptWorkflowInputs(inputDefs);
}
