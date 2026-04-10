import { generateObject } from "ai";
import { openai } from "@ai-sdk/openai";
import * as z from "zod/v4";
import { DBUserMessage } from "@leo/shared";
import { richTextToPlainText } from "@/components/promptbox/tiptap-to-richtext";
import { env } from "@leo/env/apps-www";

const threadNameSchema = z.object({
  name: z
    .string()
    .describe("Concise thread name that captures the main intent or task"),
});

export async function generateThreadName(
  message: DBUserMessage,
): Promise<string | null> {
  if (!env.OPENAI_API_KEY) {
    return null;
  }
  console.log("generateThreadName", message);
  const prompt = message.parts
    .map((part) => {
      if (part.type === "text") {
        return part.text;
      } else if (part.type === "rich-text") {
        return richTextToPlainText(part);
      } else if (part.type === "image") {
        return "<image>";
      }
      return "";
    })
    .join(" ");

  const promptTemplate = `Based on the following user prompt, generate a concise thread name that captures the main intent or task. The name should be:
- Clear and descriptive
- Focus on the main action or goal
- Professional and readable
- Use imperative mood when possible
- No articles (a, an, the) unless necessary
- 7 words maximum

<UserPrompt>
${prompt}
</UserPrompt>

Examples of good thread names:
- "Fix login authentication bug"
- "Add dark mode toggle"
- "Optimize database queries"
- "Setup CI/CD pipeline"
- "Refactor user components"

Generate a name that someone could easily understand at a glance.`;

  try {
    const result = await generateObject({
      model: openai("gpt-4.1-mini"),
      schema: threadNameSchema,
      prompt: promptTemplate,
    });
    console.log("[ai/generateObject] response_id:", result.response?.id);
    return (result.object as z.infer<typeof threadNameSchema>).name;
  } catch (error) {
    console.error("Failed to generate thread name:", error);
    // Fallback to the original prompt
    return prompt;
  }
}
