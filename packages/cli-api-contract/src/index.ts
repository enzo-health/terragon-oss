import { oc as ocBase } from "@orpc/contract";
import { AIModelExternalSchema } from "@terragon/agent/types";
import * as z from "zod/v4";

const oc = ocBase.errors({
  UNAUTHORIZED: {
    message: "Unauthorized",
  },
  NOT_FOUND: {
    message: "Not found",
  },
  INTERNAL_ERROR: {
    message: "Internal server error",
  },
  RATE_LIMIT_EXCEEDED: {
    message: "Rate limit exceeded",
  },
});

// Define individual contracts
const listThreadsContract = oc
  .input(
    z.object({
      repo: z.string().optional(),
    }),
  )
  .output(
    z.array(
      z.object({
        id: z.string(),
        name: z.string().nullable(),
        branchName: z.string().nullable(),
        githubRepoFullName: z.string().nullable(),
        githubPRNumber: z.number().nullable(),
        status: z.string(),
        updatedAt: z.date(),
        isUnread: z.boolean(),
        hasChanges: z.boolean().optional(),
      }),
    ),
  );

const threadDetailContract = oc
  .input(
    z.object({
      threadId: z.string(),
    }),
  )
  .output(
    z.object({
      threadId: z.string(),
      sessionId: z.string().nullable(),
      name: z.string().nullable(),
      branchName: z.string().nullable(),
      baseBranchName: z.string().nullable(),
      githubRepoFullName: z.string().nullable(),
      githubPRNumber: z.number().nullable(),
      jsonl: z.array(z.any()).nullable(),
      agent: z.enum(["claudeCode", "gemini", "amp", "codex", "opencode"]),
      hasChanges: z.boolean().optional(),
    }),
  );

const createThreadContract = oc
  .input(
    z.object({
      message: z.string(),
      githubRepoFullName: z.string(),
      repoBaseBranchName: z.string().optional(),
      createNewBranch: z.boolean().optional(),
      // Optional task mode from CLI
      mode: z.enum(["plan", "execute"]).optional(),
      // Optional model selection from CLI
      model: AIModelExternalSchema.optional(),
    }),
  )
  .output(
    z.object({
      threadId: z.string(),
      branchName: z.string().nullable(),
    }),
  );

// Delivery loop status contract - provides UI workflow state for QA comparisons
const deliveryLoopStatusContract = oc
  .input(
    z.object({
      threadId: z.string(),
    }),
  )
  .output(
    z
      .object({
        loopId: z.string(),
        state: z.string(),
        planApprovalPolicy: z.enum(["auto", "human_required"]),
        stateLabel: z.string(),
        explanation: z.string(),
        progressPercent: z.number().int().min(0).max(100),
        actions: z.object({
          canResume: z.boolean(),
          canBypassOnce: z.boolean(),
          canApprovePlan: z.boolean(),
        }),
        phases: z.array(
          z.object({
            key: z.enum([
              "planning",
              "implementing",
              "reviewing",
              "ci",
              "ui_testing",
            ]),
            label: z.string(),
            status: z.string(),
          }),
        ),
        checks: z.array(
          z.object({
            key: z.string(),
            label: z.string(),
            status: z.string(),
            detail: z.string(),
          }),
        ),
        needsAttention: z.object({
          isBlocked: z.boolean(),
          blockerCount: z.number().int().min(0),
          topBlockers: z.array(
            z.object({
              title: z.string(),
              source: z.string(),
            }),
          ),
        }),
        links: z.object({
          pullRequestUrl: z.string().url().nullable(),
          statusCommentUrl: z.string().url().nullable(),
          checkRunUrl: z.string().url().nullable(),
        }),
        artifacts: z.object({
          planningArtifact: z
            .object({
              id: z.string(),
              status: z.enum([
                "generated",
                "approved",
                "accepted",
                "rejected",
                "superseded",
              ]),
              updatedAtIso: z.string().datetime(),
              planText: z.string().nullable(),
            })
            .nullable(),
          implementationArtifact: z
            .object({
              id: z.string(),
              status: z.enum([
                "generated",
                "approved",
                "accepted",
                "rejected",
                "superseded",
              ]),
              headSha: z.string().nullable(),
              updatedAtIso: z.string().datetime(),
            })
            .nullable(),
          plannedTaskSummary: z.object({
            total: z.number().int().min(0),
            done: z.number().int().min(0),
            remaining: z.number().int().min(0),
          }),
          plannedTasks: z.array(
            z.object({
              stableTaskId: z.string(),
              title: z.string(),
              description: z.string().nullable(),
              acceptance: z.array(z.string()),
              status: z.enum([
                "todo",
                "in_progress",
                "done",
                "blocked",
                "skipped",
              ]),
            }),
          ),
        }),
        updatedAtIso: z.string().datetime(),
      })
      .nullable(),
  );

// Define the CLI API contract router
export const cliAPIContract = {
  threads: {
    list: listThreadsContract,
    detail: threadDetailContract,
    create: createThreadContract,
    deliveryLoopStatus: deliveryLoopStatusContract,
  },
  auth: {
    // Minimal endpoint for VSCode to discover the current user id
    whoami: oc.input(z.void()).output(z.object({ userId: z.string() })),
  },
};
