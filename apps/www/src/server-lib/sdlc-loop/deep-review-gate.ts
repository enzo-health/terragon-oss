import { generateObject } from "ai";
import { openai } from "@ai-sdk/openai";
import {
  DeepReviewGateOutput,
  deepReviewGateOutputSchema,
} from "@terragon/shared/model/sdlc-loop";

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
  prNumber: number;
  headSha: string;
  taskContext: string;
  gitDiff: string;
}) {
  return `Repository: ${repoFullName}\nPR: #${prNumber}\nHead SHA: ${headSha}\nPrompt Version: ${DEEP_REVIEW_GATE_PROMPT_VERSION}\n\nTask context:\n${taskContext}\n\nGit diff:\n<git-diff>\n${gitDiff}\n</git-diff>\n\nReturn JSON with shape:\n{\n  "gatePassed": boolean,\n  "blockingFindings": [\n    {\n      "stableFindingId": string (optional),\n      "title": string,\n      "severity": "critical"|"high"|"medium"|"low",\n      "category": string,\n      "detail": string,\n      "suggestedFix": string | null,\n      "isBlocking": boolean\n    }\n  ]\n}`;
}

export async function runDeepReviewGate({
  repoFullName,
  prNumber,
  headSha,
  taskContext,
  gitDiff,
  model = "gpt-4.1-mini",
}: {
  repoFullName: string;
  prNumber: number;
  headSha: string;
  taskContext: string;
  gitDiff: string;
  model?: string;
}): Promise<DeepReviewGateOutput> {
  const result = await generateObject({
    model: openai(model),
    schema: deepReviewGateOutputSchema,
    system: DEEP_REVIEW_GATE_SYSTEM_PROMPT,
    prompt: buildDeepReviewGatePrompt({
      repoFullName,
      prNumber,
      headSha,
      taskContext,
      gitDiff,
    }),
  });

  console.log("[ai/deep-review-gate] response_id:", result.response?.id);
  return result.object as DeepReviewGateOutput;
}
