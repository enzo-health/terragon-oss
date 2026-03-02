import { generateObject } from "ai";
import { openai } from "@ai-sdk/openai";
import * as z from "zod/v4";
import { generateRandomBranchName } from "@terragon/sandbox/utils";
import { env } from "@terragon/env/apps-www";

const branchNameSchema = z.object({
  name: z
    .string()
    .describe("Branch name using lowercase letters, numbers, and hyphens"),
});

export async function generateBranchName(
  threadName: string | null,
  branchPrefix: string,
): Promise<string> {
  console.log("generateBranchName", threadName);
  // Do not modify the provided prefix; use it as-is
  const prefix = branchPrefix;
  // If no thread name provided, skip AI generation and return simple unique branch name
  if (!threadName) {
    return generateRandomBranchName(prefix);
  }
  // In test environment, skip AI generation and return simple unique branch name
  if (process.env.NODE_ENV === "test") {
    return generateRandomBranchName(prefix);
  }
  // If no OpenAI API key, skip AI generation
  if (!env.OPENAI_API_KEY) {
    return generateRandomBranchName(prefix);
  }
  try {
    const result = await generateObject({
      model: openai("gpt-4.1-mini"),
      schema: branchNameSchema,
      prompt: `Based on the following thread name, generate a concise branch name that captures the main purpose or feature being worked on. The name should be:
- Lowercase letters, numbers, and hyphens only
- No spaces or special characters
- Clear and descriptive
- Between 3-30 characters
- Follow common git branch naming conventions

Thread name:
${threadName}

Examples of good branch names:
- add-user-auth
- fix-memory-leak
- update-dependencies
- refactor-api
- implement-search
- optimize-performance

Generate a name that clearly indicates what's being worked on in this branch.`,
    });
    console.log("[ai/generateObject] response_id:", result.response?.id);
    return `${prefix}${(result.object as z.infer<typeof branchNameSchema>).name}`;
  } catch (error) {
    console.error("Failed to generate branch name:", error);
    // Fallback to the default random branch name
    return generateRandomBranchName(prefix);
  }
}
