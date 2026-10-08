import { z } from "zod";

export const PrStatusSchema = z.enum(["open", "closed", "all"]);
export const GitPlatformSchema = z.enum(["gitea", "github"]);

export const CreatePrAfterMergeSchema = z.object({
  // empty array allowed = no post-merge workflow waits
  waitFor: z.array(z.string().min(1)),
});

const CreatePrStepShared = {
  type: z.literal("create-pr"),
  sourceBranch: z.string().min(1).optional(),
  destinationBranch: z.string().min(1),
  title: z.string().optional(),
  body: z.string().optional(),
  eager: z.boolean().default(false),
  needConfirmation: z.boolean().default(false),
};

/** merge:true requires afterMerge; merge:false forbids it. */
export const CreatePrStepSchema = z.discriminatedUnion("merge", [
  z.object({
    ...CreatePrStepShared,
    merge: z.literal(true),
    afterMerge: CreatePrAfterMergeSchema,
  }),
  z.object({
    ...CreatePrStepShared,
    merge: z.literal(false),
  }),
]);

export const RunWorkflowStepSchema = z.object({
  type: z.literal("run-workflow"),
  workflow: z.string().min(1),
  ref: z.string().min(1),
  eager: z.boolean(),
  needConfirmation: z.boolean().default(false),
  waitUntilFinish: z.boolean().default(false),
  exitOnError: z.boolean().default(true),
});

export const ListPrStepSchema = z.object({
  type: z.literal("list-pr"),
  status: PrStatusSchema,
  user: z.string().optional(),
  /** Run before eager preflight prompts; skipped in the main step loop. */
  bypassEager: z.boolean().default(false),
});

export const MergePrWhenSchema = z.object({
  destinationBranch: z.string().min(1),
  waitFor: z.array(z.string().min(1)).min(1),
});

export const MergePrStepSchema = z.object({
  type: z.literal("merge-pr"),
  when: z.array(MergePrWhenSchema).default([]),
});

/** Flat executable steps (no nesting). */
export const LeafStepSchema = z.union([
  CreatePrStepSchema,
  RunWorkflowStepSchema,
  ListPrStepSchema,
  MergePrStepSchema,
]);

/** One-level exclusive choice: steps → subSteps only. */
export const StepGroupSchema = z.object({
  eager: z.boolean().default(false),
  subSteps: z.array(LeafStepSchema).min(2),
});

export const PipelineStepSchema = z.union([LeafStepSchema, StepGroupSchema]);

/** @deprecated Prefer LeafStepSchema / PipelineStepSchema */
export const StepSchema = LeafStepSchema;

/** On-disk repo file shape (label comes from the filename). */
export const RepoFileSchema = z.object({
  url: z.string().url(),
  gitPlatform: GitPlatformSchema,
  steps: z.array(PipelineStepSchema).min(1),
});

export type RepoFile = z.infer<typeof RepoFileSchema>;

/** In-memory repo config after label is injected from the filename stem. */
export type RepoConfig = RepoFile & { label: string };

export type AppConfig = RepoConfig[];

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
    head: z
      .object({
        ref: z.string().optional(),
        sha: z.string().optional(),
      })
      .passthrough()
      .optional(),
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

export const CommitStatusSchema = z
  .object({
    state: z.string(),
    total_count: z.number().optional().default(0),
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

export type PrStatus = z.infer<typeof PrStatusSchema>;
export type GitPlatform = z.infer<typeof GitPlatformSchema>;
export type CreatePrAfterMerge = z.infer<typeof CreatePrAfterMergeSchema>;
export type CreatePrStep = z.infer<typeof CreatePrStepSchema>;
export type RunWorkflowStep = z.infer<typeof RunWorkflowStepSchema>;
export type ListPrStep = z.infer<typeof ListPrStepSchema>;
export type MergePrWhen = z.infer<typeof MergePrWhenSchema>;
export type MergePrStep = z.infer<typeof MergePrStepSchema>;
export type LeafStep = z.infer<typeof LeafStepSchema>;
export type StepGroup = z.infer<typeof StepGroupSchema>;
export type PipelineStep = z.infer<typeof PipelineStepSchema>;
/** Leaf step alias for older call sites. */
export type Step = LeafStep;
export type WorkflowInputValues = z.infer<typeof WorkflowInputValuesSchema>;
export type WorkflowHistoryEntry = z.infer<typeof WorkflowHistoryEntrySchema>;
export type HistoryFile = z.infer<typeof HistoryFileSchema>;
export type YamlInput = z.infer<typeof YamlInputSchema>;
export type PullRequest = z.infer<typeof PullRequestSchema>;
export type ContentFile = z.infer<typeof ContentFileSchema>;
export type CompareResult = z.infer<typeof CompareResultSchema>;
export type CommitStatus = z.infer<typeof CommitStatusSchema>;
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;

export type ParsedRepo = {
  apiBase: string;
  owner: string;
  repo: string;
  url: string;
  gitPlatform: GitPlatform;
};

/** Composite step key → precollected workflow inputs */
export type EagerInputMap = Map<string, WorkflowInputValues>;

/** Composite step key → resolved create-pr source branch for this run */
export type SourceBranchMap = Map<string, string>;

/** Top-level step indices skipped by needConfirmation (eager preflight) */
export type SkippedStepSet = Set<number>;

/** Top-level group index → chosen subStep index */
export type SelectedSubStepMap = Map<number, number>;

/** Composite step key → precollected merge-pr number */
export type MergePrNumberMap = Map<string, number>;

export function isStepGroup(step: PipelineStep): step is StepGroup {
  return "subSteps" in step && Array.isArray((step as StepGroup).subSteps);
}

export function stepKey(stepIndex: number, subIndex?: number): string {
  return subIndex === undefined
    ? String(stepIndex)
    : `${stepIndex}:${subIndex}`;
}

export function formatZodError(err: z.ZodError): string {
  return err.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("\n");
}
