import {
  CarmackReviewGateOutput,
  carmackReviewGateOutputSchema,
} from "@terragon/shared/model/delivery-loop";
import type { ISandboxSession } from "@terragon/sandbox/types";
import { runStructuredCodexGateInSandbox } from "./sandbox-codex-gate";

export const CARMACK_REVIEW_GATE_PROMPT_VERSION = 1;

/**
 * Maximum characters of git diff to include in gate prompts.
 * Shared limit with deep-review-gate — keeps Codex within context window.
 */
const MAX_GATE_DIFF_CHARS = 100_000;

export const CARMACK_REVIEW_GATE_SYSTEM_PROMPT = `You are the Carmack Review gate for an autonomous Delivery Loop.
Return strict JSON only.
Focus on architectural correctness, determinism, idempotency, race safety, and edge-case handling.
Only include findings that must be fixed before progression.
Set gatePassed=true only when there are zero blocking findings.`;

function truncateDiffForGate(gitDiff: string): string {
  if (gitDiff.length <= MAX_GATE_DIFF_CHARS) return gitDiff;
  return (
    gitDiff.slice(0, MAX_GATE_DIFF_CHARS) +
    "\n\n[... diff truncated to fit context window — review the included portion only ...]"
  );
}

export function buildCarmackReviewGatePrompt({
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
  const safeDiff = truncateDiffForGate(gitDiff);
  return `Repository: ${repoFullName}\nPR: ${prLabel}\nHead SHA: ${headSha}\nPrompt Version: ${CARMACK_REVIEW_GATE_PROMPT_VERSION}\n\nTask context:\n${taskContext}\n\nGit diff:\n<git-diff>\n${safeDiff}\n</git-diff>\n\nReturn JSON with shape:\n{\n  "gatePassed": boolean,\n  "blockingFindings": [\n    {\n      "stableFindingId": string (optional),\n      "title": string,\n      "severity": "critical"|"high"|"medium"|"low",\n      "category": string,\n      "detail": string,\n      "suggestedFix": string | null,\n      "isBlocking": boolean\n    }\n  ]\n}`;
}

export async function runCarmackReviewGate({
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
}): Promise<CarmackReviewGateOutput> {
  return await runStructuredCodexGateInSandbox({
    session,
    gateName: "carmack-review",
    model,
    schema: carmackReviewGateOutputSchema,
    prompt: [
      CARMACK_REVIEW_GATE_SYSTEM_PROMPT,
      "",
      buildCarmackReviewGatePrompt({
        repoFullName,
        prNumber,
        headSha,
        taskContext,
        gitDiff,
      }),
    ].join("\n"),
  });
}
