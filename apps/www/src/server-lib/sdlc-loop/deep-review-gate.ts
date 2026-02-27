import {
  DeepReviewGateOutput,
  deepReviewGateOutputSchema,
} from "@terragon/shared/model/sdlc-loop";
import type { ISandboxSession } from "@terragon/sandbox/types";
import { runStructuredCodexGateInSandbox } from "./sandbox-codex-gate";

export const DEEP_REVIEW_GATE_PROMPT_VERSION = 1;

export const DEEP_REVIEW_GATE_SYSTEM_PROMPT = `You are the Deep Review gate for an autonomous SDLC loop.
Return strict JSON only.
Identify only actionable, code-level defects that must be fixed before progression.
Each finding must include stable fields so retries remain deterministic.
Set gatePassed=true only when there are zero blocking findings.`;

export function buildDeepReviewGatePrompt({
  repoFullName,
  prNumber,
  headSha,
  taskContext,
  gitDiff,
}: {
  repoFullName: string;
  prNumber: number | null;
  headSha: string;
  taskContext: string;
  gitDiff: string;
}) {
  const prLabel = prNumber === null ? "not-created-yet" : `#${prNumber}`;
  return `Repository: ${repoFullName}\nPR: ${prLabel}\nHead SHA: ${headSha}\nPrompt Version: ${DEEP_REVIEW_GATE_PROMPT_VERSION}\n\nTask context:\n${taskContext}\n\nGit diff:\n<git-diff>\n${gitDiff}\n</git-diff>\n\nReturn JSON with shape:\n{\n  "gatePassed": boolean,\n  "blockingFindings": [\n    {\n      "stableFindingId": string (optional),\n      "title": string,\n      "severity": "critical"|"high"|"medium"|"low",\n      "category": string,\n      "detail": string,\n      "suggestedFix": string | null,\n      "isBlocking": boolean\n    }\n  ]\n}`;
}

export async function runDeepReviewGate({
  session,
  repoFullName,
  prNumber,
  headSha,
  taskContext,
  gitDiff,
  model = "gpt-5.3-codex-medium",
}: {
  session: ISandboxSession;
  repoFullName: string;
  prNumber: number | null;
  headSha: string;
  taskContext: string;
  gitDiff: string;
  model?: string;
}): Promise<DeepReviewGateOutput> {
  return await runStructuredCodexGateInSandbox({
    session,
    gateName: "deep-review",
    model,
    schema: deepReviewGateOutputSchema,
    prompt: [
      DEEP_REVIEW_GATE_SYSTEM_PROMPT,
      "",
      buildDeepReviewGatePrompt({
        repoFullName,
        prNumber,
        headSha,
        taskContext,
        gitDiff,
      }),
    ].join("\n"),
  });
}
