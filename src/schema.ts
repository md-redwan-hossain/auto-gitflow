import { z } from "zod";

export const AskYesNoSchema = z.enum(["ask", "yes", "no"]);
export const PrStatusSchema = z.enum(["open", "closed", "all"]);
export const GitPlatformSchema = z.enum(["gitea", "github"]);

export const CreatePrStepSchema = z.object({
  type: z.literal("create-pr"),
  sourceBranch: z.string().min(1).optional(),
  destinationBranch: z.string().min(1),
  mergeWhenChecksSucceed: AskYesNoSchema,
  // empty array allowed = no post-merge workflow waits
  waitFor: z.array(z.string().min(1)),
  title: z.string().optional(),
  body: z.string().optional(),
  eager: z.boolean().default(false),
  needConfirmation: z.boolean().default(false),
});

export const RunWorkflowStepSchema = z.object({
  type: z.literal("run-workflow"),
  workflow: z.string().min(1),
  ref: z.string().min(1),
  eager: z.boolean(),
  needConfirmation: z.boolean().default(false),
});

export const ListPrStepSchema = z.object({
  type: z.literal("list-pr"),
  status: PrStatusSchema,
  user: z.string().optional(),
  /** Run before eager preflight prompts; skipped in the main step loop. */
  bypassEager: z.boolean().default(false),
});

export const StepSchema = z.discriminatedUnion("type", [
  CreatePrStepSchema,
  RunWorkflowStepSchema,
  ListPrStepSchema,
]);

export const RepoConfigSchema = z.object({
  url: z.string().url(),
  label: z.string().min(1),
  gitPlatform: GitPlatformSchema,
  steps: z.array(StepSchema).min(1),
});

export const AppConfigSchema = z.array(RepoConfigSchema).min(1);

export const WorkflowInputValuesSchema = z.record(
  z.string(),
  z.union([z.string(), z.boolean(), z.number()]),
);

export const WorkflowHistoryEntrySchema = z.object({
  name: z.string(),
  lastUsed: z.array(WorkflowInputValuesSchema),
});

export const HistoryFileSchema = z.object({
  workflowLogs: z
    .record(z.string(), z.array(WorkflowHistoryEntrySchema))
    .default({}),
  sourceBranches: z.record(z.string(), z.string().min(1)).default({}),
});

export const YamlInputSchema = z
  .object({
    description: z.string().optional(),
    required: z.boolean().optional(),
    default: z.union([z.string(), z.boolean(), z.number()]).optional(),
    type: z.string().optional(),
    options: z.array(z.string()).optional(),
  })
  .passthrough();

export const WorkflowDocSchema = z
  .object({
    on: z
      .union([
        z.string(),
        z.array(z.string()),
        z
          .object({
            workflow_dispatch: z
              .object({
                inputs: z.record(z.string(), YamlInputSchema).optional(),
              })
              .passthrough()
              .nullable()
              .optional(),
          })
          .passthrough(),
      ])
      .optional(),
  })
  .passthrough();

export const PullRequestSchema = z
  .object({
    number: z.number(),
    html_url: z.string(),
    mergeable: z.boolean().nullable().optional().default(null),
    merged: z.boolean().optional().default(false),
    merged_at: z.string().nullable().optional(),
    title: z.string(),
    state: z.string(),
    user: z
      .object({
        login: z.string(),
        full_name: z.string().optional(),
      })
      .passthrough()
      .optional(),
    base: z.object({ ref: z.string() }).passthrough().optional(),
    head: z.object({ ref: z.string() }).passthrough().optional(),
    node_id: z.string().optional(),
  })
  .passthrough();

export const PullRequestListSchema = z.array(PullRequestSchema);

export const ContentFileSchema = z
  .object({
    content: z.string(),
    encoding: z.string(),
    name: z.string(),
    path: z.string(),
  })
  .passthrough();

export const CompareResultSchema = z
  .object({
    total_commits: z.number().optional(),
    ahead_by: z.number().optional(),
    commits: z.array(z.unknown()).optional(),
  })
  .passthrough();

export const LooseObjectSchema = z.record(z.string(), z.unknown());

export const WorkflowRunsResponseSchema = z.union([
  z.array(z.unknown()),
  z
    .object({
      workflow_runs: z.array(z.unknown()).optional(),
      runs: z.array(z.unknown()).optional(),
      data: z.array(z.unknown()).optional(),
    })
    .passthrough(),
]);

export const WorkflowRunSchema = z.object({
  id: z.number(),
  name: z.string().optional(),
  status: z.string().optional(),
  conclusion: z.string().nullable().optional(),
  event: z.string().optional(),
  html_url: z.string().optional(),
  created_at: z.string().optional(),
  run_started_at: z.string().optional(),
  updated_at: z.string().optional(),
  head_branch: z.string().optional(),
  display_title: z.string().optional(),
});

export const GraphqlEnvelopeSchema = z
  .object({
    data: z.unknown().optional(),
    errors: z.array(z.object({ message: z.string() }).passthrough()).optional(),
  })
  .passthrough();

export const EnableAutoMergeDataSchema = z
  .object({
    enablePullRequestAutoMerge: z
      .object({
        pullRequest: z
          .object({
            autoMergeRequest: z
              .object({
                enabledAt: z.string().optional(),
              })
              .passthrough()
              .nullable()
              .optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export type AskYesNo = z.infer<typeof AskYesNoSchema>;
export type PrStatus = z.infer<typeof PrStatusSchema>;
export type GitPlatform = z.infer<typeof GitPlatformSchema>;
export type CreatePrStep = z.infer<typeof CreatePrStepSchema>;
export type RunWorkflowStep = z.infer<typeof RunWorkflowStepSchema>;
export type ListPrStep = z.infer<typeof ListPrStepSchema>;
export type Step = z.infer<typeof StepSchema>;
export type RepoConfig = z.infer<typeof RepoConfigSchema>;
export type AppConfig = z.infer<typeof AppConfigSchema>;
export type WorkflowInputValues = z.infer<typeof WorkflowInputValuesSchema>;
export type WorkflowHistoryEntry = z.infer<typeof WorkflowHistoryEntrySchema>;
export type HistoryFile = z.infer<typeof HistoryFileSchema>;
export type YamlInput = z.infer<typeof YamlInputSchema>;
export type PullRequest = z.infer<typeof PullRequestSchema>;
export type ContentFile = z.infer<typeof ContentFileSchema>;
export type CompareResult = z.infer<typeof CompareResultSchema>;
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;

export type ParsedRepo = {
  apiBase: string;
  owner: string;
  repo: string;
  url: string;
  gitPlatform: GitPlatform;
};

/** step index → precollected workflow inputs */
export type EagerInputMap = Map<number, WorkflowInputValues>;

/** step index → resolved create-pr source branch for this run */
export type SourceBranchMap = Map<number, string>;

/** step indices skipped by needConfirmation (eager preflight) */
export type SkippedStepSet = Set<number>;

export function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("\n");
}
