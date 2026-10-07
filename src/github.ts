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

export class GitHubClient implements GitHostClient {
  readonly workflowsDir = workflowsDirFor("github");

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
    return this.request<PullRequest>(
      "POST",
      `/repos/${this.owner}/${this.repo}/pulls`,
      {
        head: opts.head,
        base: opts.base,
        title: opts.title,
        body: opts.body ?? "",
      },
    );
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
    const ghState = state === "all" ? "all" : state;

    for (let page = 1; page <= maxPages; page++) {
      const batch = await this.request<PullRequest[]>(
        "GET",
        `/repos/${this.owner}/${this.repo}/pulls?state=${encodeURIComponent(ghState)}&page=${page}&per_page=${perPage}`,
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
      ahead_by?: number;
      commits?: unknown[];
    }>("GET", path);

    if (typeof data.ahead_by === "number") {
      return { total_commits: data.ahead_by };
    }
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
    if (opts.mergeWhenChecksSucceed) {
      await this.enableAutoMerge(index);
      return;
    }

    await this.request(
      "PUT",
      `/repos/${this.owner}/${this.repo}/pulls/${index}/merge`,
      { merge_method: "merge" },
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
      `/repos/${this.owner}/${this.repo}/actions/workflows/${workflowId}/runs?per_page=${limit}`,
      `/repos/${this.owner}/${this.repo}/actions/runs?per_page=${limit}`,
    ];

    const byId = new Map<number, WorkflowRun>();
    let lastError: unknown;
    let anyOk = false;

    for (const [i, path] of paths.entries()) {
      try {
        const data = await this.request<unknown>("GET", path);
        const rawRuns = extractWorkflowRuns(data);
        for (const raw of rawRuns) {
          const run = normalizeWorkflowRun(raw);
          if (!run) continue;
          if (i > 0 && !runMatchesWorkflow(raw, workflowFile)) {
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

  private async enableAutoMerge(prNumber: number): Promise<void> {
    const pr = await this.getPullRequest(prNumber);
    const nodeId = pr.node_id;
    if (!nodeId) {
      throw new Error(
        `PR #${prNumber} has no node_id; cannot enable GitHub auto-merge`,
      );
    }

    const data = await this.graphql<{
      enablePullRequestAutoMerge?: {
        pullRequest?: { autoMergeRequest?: { enabledAt?: string } | null };
      };
      errors?: { message: string }[];
    }>(
      `mutation($pullRequestId: ID!) {
        enablePullRequestAutoMerge(input: {
          pullRequestId: $pullRequestId
          mergeMethod: MERGE
        }) {
          pullRequest { autoMergeRequest { enabledAt } }
        }
      }`,
      { pullRequestId: nodeId },
    );

    if (data.errors?.length) {
      throw new Error(
        `GitHub auto-merge failed for PR #${prNumber}: ${data.errors.map((e) => e.message).join("; ")}. Enable auto-merge on the repository settings.`,
      );
    }

    const enabled =
      data.enablePullRequestAutoMerge?.pullRequest?.autoMergeRequest?.enabledAt;
    if (!enabled) {
      throw new Error(
        `GitHub auto-merge was not enabled for PR #${prNumber}. Enable auto-merge in the repo settings (Settings → General → Allow auto-merge).`,
      );
    }
  }

  private async graphql<T>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    const url =
      this.parsed.apiBase === "https://api.github.com"
        ? "https://api.github.com/graphql"
        : `${new URL(this.parsed.apiBase).origin}/api/graphql`;

    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: JSON.stringify({ query, variables }),
    });

    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      throw new Error(`GitHub GraphQL → ${res.status}: ${text}`);
    }

    if (!res.ok) {
      throw new Error(`GitHub GraphQL → ${res.status}: ${text}`);
    }

    const payload = data as { data?: T; errors?: { message: string }[] };
    if (payload.errors?.length) {
      return { ...payload.data, errors: payload.errors } as T;
    }
    return (payload.data ?? data) as T;
  }

  private async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.parsed.apiBase}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
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
      throw new Error(`GitHub ${method} ${path} → ${res.status}: ${message}`);
    }

    return data as T;
  }
}
