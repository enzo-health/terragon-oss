import { generateObject } from "ai";
import * as z from "zod/v4";
import { openai } from "@ai-sdk/openai";
import { env } from "@leo/env/apps-www";

// Zod schemas for structured data generation
const commitMessageSchema = z.object({
  type: z.enum(["feat", "fix", "docs", "style", "refactor", "test", "chore"]),
  scope: z.string().optional(),
  description: z.string().describe("Brief description of the change"),
  message: z.string().describe("Complete conventional commit message"),
});

export async function generateCommitMessage(gitDiff: string): Promise<string> {
  if (!env.OPENAI_API_KEY) {
    return "chore: update code";
  }
  const result = await generateObject({
    model: openai("gpt-4.1-mini"),
    schema: commitMessageSchema,
    prompt: `Based on the following git diff, generate a structured commit message that follows conventional commit format. Focus on the primary change being made.

    Git diff:
    <git-diff>
    ${gitDiff}
    </git-diff>

    Analyze the changes and provide:
    - type: one of feat, fix, docs, style, refactor, test, chore
    - scope: optional area of change (e.g., auth, ui, api)
    - description: brief description under 72 characters
    - message: complete conventional commit message in format "type(scope): description"`,
  });
  console.log("[ai/generateObject] response_id:", result.response?.id);
  return (result.object as z.infer<typeof commitMessageSchema>).message;
}
