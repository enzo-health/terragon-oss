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

// Define the CLI API contract router
export const cliAPIContract = {
  threads: {
    list: listThreadsContract,
    detail: threadDetailContract,
    create: createThreadContract,
  },
  auth: {
    // Minimal endpoint for VSCode to discover the current user id
    whoami: oc.input(z.void()).output(z.object({ userId: z.string() })),
  },
};
