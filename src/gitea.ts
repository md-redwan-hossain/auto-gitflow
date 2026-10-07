import {
  extractWorkflowRuns,
  normalizeRef,
  normalizeWorkflowRun,
  runMatchesWorkflow,
  runSortMs,
  workflowsDirFor,
  type ContentFile,
  type GitHostClient,
  type PullRequest,
  type WorkflowRun,
} from "./git-host.ts";
import type { ParsedRepo, PrStatus } from "./schema.ts";

/** @deprecated Use PullRequest from git-host.ts */
export type GiteaPullRequest = PullRequest;
/** @deprecated Use WorkflowRun from git-host.ts */
export type GiteaWorkflowRun = WorkflowRun;

export class GiteaClient implements GitHostClient {
  readonly workflowsDir = workflowsDirFor("gitea");

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
  }): Promise<PullRequest> {
    return this.request<PullRequest>("POST", `/repos/${this.owner}/${this.repo}/pulls`, {
      head: opts.head,
      base: opts.base,
      title: opts.title,
      body: opts.body ?? "",
    });
  }

  async getPullRequest(index: number): Promise<PullRequest> {
    return this.request<PullRequest>(
      "GET",
      `/repos/${this.owner}/${this.repo}/pulls/${index}`,
    );
  }

  async listPullRequests(state: PrStatus): Promise<PullRequest[]> {
    const perPage = 50;
    const maxPages = 2;
    const all: PullRequest[] = [];

    for (let page = 1; page <= maxPages; page++) {
      const batch = await this.request<PullRequest[]>(
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
  ): Promise<PullRequest | undefined> {
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
    const file = await this.request<ContentFile>(
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

  async branchExists(name: string): Promise<boolean> {
    try {
      await this.request(
        "GET",
        `/repos/${this.owner}/${this.repo}/branches/${encodeURIComponent(name)}`,
      );
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("→ 404")) return false;
      throw err;
    }
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
  ): Promise<WorkflowRun[]> {
    const workflowId = encodeURIComponent(workflowFile);
    const paths = [
      `/repos/${this.owner}/${this.repo}/actions/workflows/${workflowId}/runs?limit=${limit}`,
      `/repos/${this.owner}/${this.repo}/actions/runs?workflow_id=${workflowId}&limit=${limit}`,
      `/repos/${this.owner}/${this.repo}/actions/runs?limit=${limit}`,
    ];

    const byId = new Map<number, WorkflowRun>();
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

export { toDispatchInputs } from "./git-host.ts";
