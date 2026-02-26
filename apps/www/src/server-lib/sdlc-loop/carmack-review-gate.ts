import { generateObject } from "ai";
import { openai } from "@ai-sdk/openai";
import {
  CarmackReviewGateOutput,
  carmackReviewGateOutputSchema,
} from "@terragon/shared/model/sdlc-loop";

export const CARMACK_REVIEW_GATE_PROMPT_VERSION = 1;

export const CARMACK_REVIEW_GATE_SYSTEM_PROMPT = `You are the Carmack Review gate for an autonomous SDLC loop.
Return strict JSON only.
Focus on architectural correctness, determinism, idempotency, race safety, and edge-case handling.
Only include findings that must be fixed before progression.
Set gatePassed=true only when there are zero blocking findings.`;

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
  return `Repository: ${repoFullName}\nPR: ${prLabel}\nHead SHA: ${headSha}\nPrompt Version: ${CARMACK_REVIEW_GATE_PROMPT_VERSION}\n\nTask context:\n${taskContext}\n\nGit diff:\n<git-diff>\n${gitDiff}\n</git-diff>\n\nReturn JSON with shape:\n{\n  "gatePassed": boolean,\n  "blockingFindings": [\n    {\n      "stableFindingId": string (optional),\n      "title": string,\n      "severity": "critical"|"high"|"medium"|"low",\n      "category": string,\n      "detail": string,\n      "suggestedFix": string | null,\n      "isBlocking": boolean\n    }\n  ]\n}`;
}

export async function runCarmackReviewGate({
  repoFullName,
  prNumber,
  headSha,
  taskContext,
  gitDiff,
  model = "gpt-4.1-mini",
}: {
  repoFullName: string;
  prNumber: number | null;
  headSha: string;
  taskContext: string;
  gitDiff: string;
  model?: string;
}): Promise<CarmackReviewGateOutput> {
  const result = await generateObject({
    model: openai(model),
    schema: carmackReviewGateOutputSchema,
    system: CARMACK_REVIEW_GATE_SYSTEM_PROMPT,
    prompt: buildCarmackReviewGatePrompt({
      repoFullName,
      prNumber,
      headSha,
      taskContext,
      gitDiff,
    }),
  });

  console.log("[ai/carmack-review-gate] response_id:", result.response?.id);
  return result.object as CarmackReviewGateOutput;
}
