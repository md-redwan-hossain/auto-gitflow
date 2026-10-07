import * as p from "@clack/prompts";
import { ZodError } from "zod";
import {
  formatZodError,
  WorkflowDocSchema,
  type WorkflowInputValues,
  type YamlInput,
} from "./schema.ts";

export function parseWorkflowDispatchInputs(
  yamlText: string,
): Record<string, YamlInput> {
  let raw: unknown;
  try {
    raw = Bun.YAML.parse(yamlText);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse workflow YAML: ${message}`);
  }

  let doc;
  try {
    doc = WorkflowDocSchema.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      throw new Error(`Invalid workflow YAML:\n${formatZodError(err)}`);
    }
    throw err;
  }

  const on = doc.on;
  if (!on || typeof on === "string" || Array.isArray(on)) {
    return {};
  }
  const dispatch = on.workflow_dispatch;
  if (!dispatch || typeof dispatch !== "object") {
    return {};
  }
  return dispatch.inputs ?? {};
}

export async function promptWorkflowInputs(
  inputDefs: Record<string, YamlInput>,
  defaults?: WorkflowInputValues,
): Promise<WorkflowInputValues> {
  const values: WorkflowInputValues = {};

  for (const [name, def] of Object.entries(inputDefs)) {
    const message = def.description?.trim() || name;
    const fromHistory = defaults?.[name];
    const initial = fromHistory !== undefined ? fromHistory : def.default;

    if (def.type === "boolean") {
      const answer = await p.confirm({
        message,
        initialValue: toBoolean(initial, Boolean(def.default)),
      });
      exitIfCancel(answer);
      values[name] = answer;
      continue;
    }

    if (def.type === "choice") {
      const options = def.options ?? [];
      if (options.length === 0) {
        throw new Error(`Workflow input "${name}" is choice but has no options`);
      }
      const initialOption =
        typeof initial === "string" && options.includes(initial)
          ? initial
          : options[0]!;
      const answer = await p.select({
        message,
        options: options.map((opt) => ({ value: opt, label: opt })),
        initialValue: initialOption,
      });
      exitIfCancel(answer);
      values[name] = answer;
      continue;
    }

    const answer = await p.text({
      message,
      initialValue:
        initial === undefined || initial === null ? "" : String(initial),
      validate: (v) => {
        if (def.required && !v?.trim()) return "Required";
      },
    });
    exitIfCancel(answer);
    values[name] = answer;
  }

  return values;
}

export function defaultsFromYaml(
  inputDefs: Record<string, YamlInput>,
): WorkflowInputValues {
  const values: WorkflowInputValues = {};
  for (const [name, def] of Object.entries(inputDefs)) {
    if (def.default !== undefined) {
      values[name] = def.default;
    } else if (def.type === "boolean") {
      values[name] = false;
    } else if (def.type === "choice" && def.options?.[0]) {
      values[name] = def.options[0];
    }
  }
  return values;
}

function toBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function exitIfCancel(value: unknown): asserts value is string | boolean {
  if (p.isCancel(value)) {
    p.cancel("Cancelled.");
    process.exit(1);
  }
}
