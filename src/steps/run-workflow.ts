import * as p from "@clack/prompts";
import ora from "ora";
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
  steps: { step: RunWorkflowStep; index: number }[],
): Promise<EagerInputMap> {
  const map: EagerInputMap = new Map();

  for (const { step, index } of steps) {
    p.log.step(`Eager inputs: ${step.workflow} @ ${step.ref}`);
    const inputs = await resolveWorkflowInputs(client, step);
    map.set(index, inputs);
    if (Object.keys(inputs).length > 0) {
      const history = loadHistory();
      recordWorkflowInputs(history, client.repoUrl, step.workflow, inputs);
      saveHistory(history);
      p.note(
        formatInputsSummary(inputs),
        `Recorded in history for step ${index + 1}`,
      );
    }
  }

  return map;
}

export async function runWorkflowStep(
  client: GitHostClient,
  step: RunWorkflowStep,
  opts?: { stepIndex?: number; eagerInputs?: EagerInputMap },
): Promise<void> {
  const precollected =
    opts?.stepIndex !== undefined
      ? opts.eagerInputs?.get(opts.stepIndex)
      : undefined;

  let inputs: WorkflowInputValues;

  if (precollected !== undefined) {
    inputs = precollected;
    p.log.info(
      Object.keys(inputs).length === 0
        ? `Using eager inputs for ${step.workflow} (none).`
        : `Using eager inputs for ${step.workflow}:\n${formatInputsSummary(inputs)}`,
    );
  } else {
    inputs = await resolveWorkflowInputs(client, step);
  }

  const dispatchSpinner = ora(
    `Dispatching ${step.workflow} on ${step.ref}`,
  ).start();

  try {
    await client.dispatchWorkflow(
      step.workflow,
      step.ref,
      toDispatchInputs(inputs),
    );
    dispatchSpinner.succeed(`Dispatched ${step.workflow}`);
  } catch (err) {
    dispatchSpinner.fail(`Failed to dispatch ${step.workflow}`);
    throw err;
  }

  if (Object.keys(inputs).length > 0) {
    const history = loadHistory();
    recordWorkflowInputs(history, client.repoUrl, step.workflow, inputs);
    saveHistory(history);
  }
}

export async function resolveWorkflowInputs(
  client: GitHostClient,
  step: RunWorkflowStep,
): Promise<WorkflowInputValues> {
  const workflowPath = `${client.workflowsDir}/${step.workflow}`;
  const fetchSpinner = ora(`Fetching ${workflowPath} @ ${step.ref}`).start();

  let yamlText: string;
  try {
    yamlText = await client.getFileContents(workflowPath, step.ref);
    fetchSpinner.succeed(`Loaded ${step.workflow}`);
  } catch (err) {
    fetchSpinner.fail(`Failed to fetch ${workflowPath}`);
    throw err;
  }

  const inputDefs = parseWorkflowDispatchInputs(yamlText);

  if (Object.keys(inputDefs).length === 0) {
    p.log.info("Workflow has no dispatch inputs.");
    return {};
  }

  return resolveInteractiveInputs(client.repoUrl, step.workflow, inputDefs);
}

async function resolveInteractiveInputs(
  repoUrl: string,
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
  const latest = getLatestWorkflowInputs(history, repoUrl, workflowName);

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
