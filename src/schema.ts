import { z } from "zod";

export const AskYesNoSchema = z.enum(["ask", "yes", "no"]);
export const PrStatusSchema = z.enum(["open", "closed", "all"]);

export const CreatePrStepSchema = z.object({
  type: z.literal("create-pr"),
  sourceBranch: z.string().min(1),
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
});

export const StepSchema = z.discriminatedUnion("type", [
  CreatePrStepSchema,
  RunWorkflowStepSchema,
  ListPrStepSchema,
]);

export const RepoConfigSchema = z.object({
  url: z.string().url(),
  label: z.string().min(1),
  steps: z.array(StepSchema).min(1),
});

export const AppConfigSchema = z.object({
  repos: z.array(RepoConfigSchema).min(1),
});

export const WorkflowInputValuesSchema = z.record(
  z.string(),
  z.union([z.string(), z.boolean(), z.number()]),
);

export const WorkflowHistoryEntrySchema = z.object({
  name: z.string(),
  lastUsed: z.array(WorkflowInputValuesSchema),
});

export const RepoHistorySchema = z.object({
  repoUrl: z.string(),
  workflows: z.array(WorkflowHistoryEntrySchema),
});

export const HistoryFileSchema = z.object({
  repos: z.array(RepoHistorySchema),
});

export type AskYesNo = z.infer<typeof AskYesNoSchema>;
export type PrStatus = z.infer<typeof PrStatusSchema>;
export type CreatePrStep = z.infer<typeof CreatePrStepSchema>;
export type RunWorkflowStep = z.infer<typeof RunWorkflowStepSchema>;
export type ListPrStep = z.infer<typeof ListPrStepSchema>;
export type Step = z.infer<typeof StepSchema>;
export type RepoConfig = z.infer<typeof RepoConfigSchema>;
export type AppConfig = z.infer<typeof AppConfigSchema>;
export type WorkflowInputValues = z.infer<typeof WorkflowInputValuesSchema>;
export type WorkflowHistoryEntry = z.infer<typeof WorkflowHistoryEntrySchema>;
export type RepoHistory = z.infer<typeof RepoHistorySchema>;
export type HistoryFile = z.infer<typeof HistoryFileSchema>;

export type ParsedRepo = {
  apiBase: string;
  owner: string;
  repo: string;
  url: string;
};

/** step index → precollected workflow inputs */
export type EagerInputMap = Map<number, WorkflowInputValues>;

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
