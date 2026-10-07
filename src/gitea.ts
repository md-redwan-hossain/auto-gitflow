import type { ParsedRepo, PrStatus, WorkflowInputValues } from "./schema.ts";

export type GiteaPullRequest = {
  number: number;
  html_url: string;
  mergeable: boolean | null;
  merged: boolean;
  merged_at?: string | null;
  title: string;
  state: string;
  user?: { login: string; full_name?: string };
  base?: { ref: string };
  head?: { ref: string };
};

export type GiteaWorkflowRun = {
  id: number;
  name?: string;
  status?: string;
  conclusion?: string | null;
  event?: string;
  html_url?: string;
  created_at?: string;
  run_started_at?: string;
  updated_at?: string;
  head_branch?: string;
  display_title?: string;
};

export type GiteaContentFile = {
  content: string;
  encoding: string;
  name: string;
  path: string;
};

export class GiteaClient {
  constructor(
    private readonly parsed: ParsedRepo,
    private readonly token: string,
  ) {}

  get owner(): string {
    return this.parsed.owner;
  }

  get repo(): string {
    return this.parsed.repo;
  }

  get repoUrl(): string {
    return this.parsed.url;
  }

  async createPullRequest(opts: {
    head: string;
    base: string;
    title: string;
    body?: string;
  }): Promise<GiteaPullRequest> {
    return this.request<GiteaPullRequest>("POST", `/repos/${this.owner}/${this.repo}/pulls`, {
      head: opts.head,
      base: opts.base,
      title: opts.title,
      body: opts.body ?? "",
    });
  }

  async getPullRequest(index: number): Promise<GiteaPullRequest> {
    return this.request<GiteaPullRequest>(
      "GET",
      `/repos/${this.owner}/${this.repo}/pulls/${index}`,
    );
  }

  async listPullRequests(state: PrStatus): Promise<GiteaPullRequest[]> {
    const perPage = 50;
    const maxPages = 2; // cap at 100
    const all: GiteaPullRequest[] = [];

    for (let page = 1; page <= maxPages; page++) {
      const batch = await this.request<GiteaPullRequest[]>(
        "GET",
        `/repos/${this.owner}/${this.repo}/pulls?state=${encodeURIComponent(state)}&page=${page}&limit=${perPage}`,
      );
      if (!Array.isArray(batch) || batch.length === 0) {
        break;
      }
      all.push(...batch);
      if (batch.length < perPage) {
        break;
      }
    }

    return all;
  }

  async findOpenPullRequest(
    head: string,
    base: string,
  ): Promise<GiteaPullRequest | undefined> {
    const open = await this.listPullRequests("open");
    return open.find(
      (pr) =>
        normalizeRef(pr.head?.ref) === normalizeRef(head) &&
        normalizeRef(pr.base?.ref) === normalizeRef(base),
    );
  }

  async compare(
    base: string,
    head: string,
  ): Promise<{ total_commits: number }> {
    const path = `/repos/${this.owner}/${this.repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
    const data = await this.request<{
      total_commits?: number;
      commits?: unknown[];
    }>("GET", path);

    if (typeof data.total_commits === "number") {
      return { total_commits: data.total_commits };
    }
    if (Array.isArray(data.commits)) {
      return { total_commits: data.commits.length };
    }
    return { total_commits: 0 };
  }

  async mergePullRequest(
    index: number,
    opts: { mergeWhenChecksSucceed: boolean },
  ): Promise<void> {
    await this.request(
      "POST",
      `/repos/${this.owner}/${this.repo}/pulls/${index}/merge`,
      {
        Do: "merge",
        merge_title_field: "",
        merge_message_field: "",
        merge_when_checks_succeed: opts.mergeWhenChecksSucceed,
        force_merge: false,
      },
    );
  }

  async getFileContents(path: string, ref: string): Promise<string> {
    const encodedPath = path
      .split("/")
      .map(encodeURIComponent)
      .join("/");
    const file = await this.request<GiteaContentFile>(
      "GET",
      `/repos/${this.owner}/${this.repo}/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`,
    );

    if (file.encoding !== "base64") {
      throw new Error(`Unexpected content encoding: ${file.encoding}`);
    }

    return Buffer.from(file.content.replace(/\n/g, ""), "base64").toString(
      "utf8",
    );
  }

  async dispatchWorkflow(
    workflow: string,
    ref: string,
    inputs: Record<string, string>,
  ): Promise<void> {
    const workflowId = encodeURIComponent(workflow);
    await this.request(
      "POST",
      `/repos/${this.owner}/${this.repo}/actions/workflows/${workflowId}/dispatches`,
      {
        ref,
        inputs,
      },
    );
  }

  async listWorkflowRuns(
    workflowFile: string,
    limit = 20,
  ): Promise<GiteaWorkflowRun[]> {
    const workflowId = encodeURIComponent(workflowFile);
    const paths = [
      `/repos/${this.owner}/${this.repo}/actions/workflows/${workflowId}/runs?limit=${limit}`,
      `/repos/${this.owner}/${this.repo}/actions/runs?workflow_id=${workflowId}&limit=${limit}`,
      `/repos/${this.owner}/${this.repo}/actions/runs?limit=${limit}`,
    ];

    const byId = new Map<number, GiteaWorkflowRun>();
    let lastError: unknown;
    let anyOk = false;

    for (const path of paths) {
      try {
        const data = await this.request<unknown>("GET", path);
        const rawRuns = extractWorkflowRuns(data);
        for (const raw of rawRuns) {
          const run = normalizeWorkflowRun(raw);
          if (!run) continue;
          if (
            path.includes("actions/runs?") &&
            !path.includes("workflow_id=") &&
            !runMatchesWorkflow(raw, workflowFile)
          ) {
            continue;
          }
          byId.set(run.id, run);
        }
        anyOk = true;
      } catch (err) {
        lastError = err;
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes("→ 404")) {
          throw err;
        }
      }
    }

    if (!anyOk && byId.size === 0) {
      throw lastError instanceof Error
        ? lastError
        : new Error(`Failed to list runs for ${workflowFile}`);
    }

    return [...byId.values()].sort(
      (a, b) => (runSortMs(b) ?? 0) - (runSortMs(a) ?? 0),
    );
  }


  private async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.parsed.apiBase}${path}`;
    const headers: Record<string, string> = {
      Authorization: `token ${this.token}`,
      Accept: "application/json",
    };

    const init: RequestInit = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    const res = await fetch(url, init);
    if (res.status === 204) {
      return undefined as T;
    }

    const text = await res.text();
    let data: unknown = undefined;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }

    if (!res.ok) {
      const message =
        typeof data === "object" &&
        data !== null &&
        "message" in data &&
        typeof (data as { message: unknown }).message === "string"
          ? (data as { message: string }).message
          : text || res.statusText;
      throw new Error(`Gitea ${method} ${path} → ${res.status}: ${message}`);
    }

    return data as T;
  }
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

export function normalizeWorkflowRun(raw: unknown): GiteaWorkflowRun | null {
  if (!raw || typeof raw !== "object") return null;

  let obj = raw as Record<string, unknown>;
  if (
    obj.workflow_run &&
    typeof obj.workflow_run === "object" &&
    !Array.isArray(obj.workflow_run)
  ) {
    obj = obj.workflow_run as Record<string, unknown>;
  }

  const id = asNumber(obj.id ?? obj.run_id);
  if (id === undefined) return null;

  const status = asString(
    obj.status ?? obj.state ?? obj.Status ?? obj.run_status,
  );
  const conclusion = asNullableString(
    obj.conclusion ?? obj.Conclusion ?? obj.result,
  );

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
    head_branch: asString(
      obj.head_branch ??
        obj.branch ??
        (obj.head && typeof obj.head === "object"
          ? (obj.head as { ref?: unknown }).ref
          : undefined),
    ),
    display_title: asString(obj.display_title ?? obj.title ?? obj.name),
  };
}

function extractWorkflowRuns(data: unknown): unknown[] {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  const obj = data as Record<string, unknown>;
  if (Array.isArray(obj.workflow_runs)) return obj.workflow_runs;
  if (Array.isArray(obj.runs)) return obj.runs;
  if (Array.isArray(obj.data)) return obj.data;
  return [];
}

function runMatchesWorkflow(raw: unknown, workflowFile: string): boolean {
  if (!raw || typeof raw !== "object") return true;
  const obj = raw as Record<string, unknown>;
  const candidates = [
    obj.path,
    obj.workflow_id,
    obj.workflow_path,
    obj.name,
    typeof obj.workflow === "object" && obj.workflow !== null
      ? (obj.workflow as { path?: unknown; name?: unknown }).path ??
        (obj.workflow as { name?: unknown }).name
      : undefined,
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

function runSortMs(run: GiteaWorkflowRun): number | undefined {
  const raw = run.run_started_at ?? run.created_at ?? run.updated_at;
  if (!raw) return undefined;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? undefined : ms;
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

function normalizeRef(ref: string | undefined): string {
  if (!ref) return "";
  return ref.replace(/^refs\/heads\//, "");
}
