import {
  LooseObjectSchema,
  WorkflowRunsResponseSchema,
  type ContentFile,
  type GitPlatform,
  type PrStatus,
  type PullRequest,
  type WorkflowInputValues,
  type WorkflowRun,
} from "./schema.ts";

export type { ContentFile, PullRequest, WorkflowRun };

export interface GitHostClient {
  readonly owner: string;
  readonly repo: string;
  readonly repoUrl: string;
  readonly workflowsDir: string;

  createPullRequest(opts: {
    head: string;
    base: string;
    title: string;
    body?: string;
  }): Promise<PullRequest>;

  getPullRequest(index: number): Promise<PullRequest>;

  listPullRequests(state: PrStatus): Promise<PullRequest[]>;

  findOpenPullRequest(
    head: string,
    base: string,
  ): Promise<PullRequest | undefined>;

  compare(base: string, head: string): Promise<{ total_commits: number }>;

  mergePullRequest(
    index: number,
    opts: { mergeWhenChecksSucceed: boolean },
  ): Promise<void>;

  getFileContents(path: string, ref: string): Promise<string>;

  branchExists(name: string): Promise<boolean>;

  dispatchWorkflow(
    workflow: string,
    ref: string,
    inputs: Record<string, string>,
  ): Promise<void>;

  listWorkflowRuns(workflowFile: string, limit?: number): Promise<WorkflowRun[]>;
}

export function workflowsDirFor(platform: GitPlatform): string {
  return platform === "github" ? ".github/workflows" : ".gitea/workflows";
}

export function toDispatchInputs(
  values: WorkflowInputValues,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (typeof value === "boolean") {
      out[key] = value ? "true" : "false";
    } else {
      out[key] = String(value);
    }
  }
  return out;
}

export function normalizeWorkflowRun(raw: unknown): WorkflowRun | null {
  const parsed = LooseObjectSchema.safeParse(raw);
  if (!parsed.success) return null;

  let obj = parsed.data;
  const nested = LooseObjectSchema.safeParse(obj.workflow_run);
  if (nested.success) {
    obj = nested.data;
  }

  const id = asNumber(obj.id ?? obj.run_id);
  if (id === undefined) return null;

  const status = asString(
    obj.status ?? obj.state ?? obj.Status ?? obj.run_status,
  );
  const conclusion = asNullableString(
    obj.conclusion ?? obj.Conclusion ?? obj.result,
  );

  const headObj = LooseObjectSchema.safeParse(obj.head);
  const headRef = headObj.success ? headObj.data.ref : undefined;

  return {
    id,
    name: asString(obj.name ?? obj.display_title ?? obj.title),
    status,
    conclusion,
    event: asString(obj.event ?? obj.trigger ?? obj.event_name),
    html_url: asString(obj.html_url ?? obj.url ?? obj.htmlUrl),
    created_at: asString(obj.created_at ?? obj.created ?? obj.Created),
    run_started_at: asString(
      obj.run_started_at ?? obj.started_at ?? obj.started ?? obj.Started,
    ),
    updated_at: asString(obj.updated_at ?? obj.updated ?? obj.Updated),
    head_branch: asString(obj.head_branch ?? obj.branch ?? headRef),
    display_title: asString(obj.display_title ?? obj.title ?? obj.name),
  };
}

export function extractWorkflowRuns(data: unknown): unknown[] {
  const parsed = WorkflowRunsResponseSchema.safeParse(data);
  if (!parsed.success) return [];
  if (Array.isArray(parsed.data)) return parsed.data;
  if (Array.isArray(parsed.data.workflow_runs)) return parsed.data.workflow_runs;
  if (Array.isArray(parsed.data.runs)) return parsed.data.runs;
  if (Array.isArray(parsed.data.data)) return parsed.data.data;
  return [];
}

export function runMatchesWorkflow(
  raw: unknown,
  workflowFile: string,
): boolean {
  const parsed = LooseObjectSchema.safeParse(raw);
  if (!parsed.success) return true;
  const obj = parsed.data;

  const workflowObj = LooseObjectSchema.safeParse(obj.workflow);
  const workflowPath = workflowObj.success
    ? (workflowObj.data.path ?? workflowObj.data.name)
    : undefined;

  const candidates = [
    obj.path,
    obj.workflow_id,
    obj.workflow_path,
    obj.name,
    workflowPath,
  ]
    .map((v) => (typeof v === "string" ? v : ""))
    .filter(Boolean);

  if (candidates.length === 0) return true;
  const needle = workflowFile.toLowerCase();
  return candidates.some(
    (c) =>
      c.toLowerCase() === needle ||
      c.toLowerCase().endsWith(`/${needle}`) ||
      c.toLowerCase().includes(needle),
  );
}

export function runSortMs(run: WorkflowRun): number | undefined {
  const raw = run.run_started_at ?? run.created_at ?? run.updated_at;
  if (!raw) return undefined;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? undefined : ms;
}

export function normalizeRef(ref: string | undefined): string {
  if (!ref) return "";
  return ref.replace(/^refs\/heads\//, "");
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return undefined;
}

function asNullableString(value: unknown): string | null | undefined {
  if (value === null) return null;
  return asString(value);
}
