import { openai } from "@ai-sdk/openai";
import { env } from "@terragon/env/apps-www";
import { generateRandomBranchName } from "@terragon/sandbox/utils";
import { generateObject } from "ai";
import * as z from "zod/v4";

const branchNameSchema = z.object({
  name: z
    .string()
    .describe("Branch name using lowercase letters, numbers, and hyphens"),
});

let shouldSkipAiBranchNameGeneration = false;

function getStatusCode(error: unknown): number | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const directStatusCode = Reflect.get(error, "statusCode");
  if (typeof directStatusCode === "number") {
    return directStatusCode;
  }
  const cause = Reflect.get(error, "cause");
  if (typeof cause === "object" && cause !== null) {
    const causeStatusCode = Reflect.get(cause, "statusCode");
    if (typeof causeStatusCode === "number") {
      return causeStatusCode;
    }
  }
  return null;
}

function isInvalidOpenAIKeyError(error: unknown): boolean {
  const statusCode = getStatusCode(error);
  if (statusCode === 401) {
    return true;
  }
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const responseBody = Reflect.get(error, "responseBody");
  if (
    typeof responseBody === "string" &&
    responseBody.toLowerCase().includes("invalid_api_key")
  ) {
    return true;
  }
  const message = Reflect.get(error, "message");
  return (
    typeof message === "string" &&
    message.toLowerCase().includes("incorrect api key")
  );
}

export async function generateBranchName(
  threadName: string | null,
  branchPrefix: string,
): Promise<string> {
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
  if (shouldSkipAiBranchNameGeneration) {
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
    if (isInvalidOpenAIKeyError(error)) {
      shouldSkipAiBranchNameGeneration = true;
      console.warn(
        "Disabling AI branch-name generation for this process after OpenAI auth failure",
      );
    } else {
      console.error("Failed to generate branch name:", error);
    }
    // Fallback to the default random branch name
    return generateRandomBranchName(prefix);
  }
}
