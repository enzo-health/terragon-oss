import { generateObject } from "ai";
import { openai } from "@ai-sdk/openai";
import * as z from "zod/v4";
import { env } from "@leo/env/apps-www";

const prContentSchema = z.object({
  title: z.string().describe("Concise pull request title"),
  body: z.string().describe("Complete PR body in markdown format"),
});

const prUpdateSchema = z.object({
  shouldUpdate: z
    .boolean()
    .describe("Whether the PR title/body should be updated"),
  title: z.string().describe("Updated pull request title"),
  body: z.string().describe("Updated PR body in markdown format"),
});

const examplePRBodies = `\
Here are some examples of good PR bodies:

Example 1:
## Summary
- Adds support for rich text formatting in user messages
- Preserves mentions, links, and formatting while maintaining Claude compatibility
- Improves visual representation of user messages in the chat UI

## Changes

### Core Functionality
- **Rich Text Conversion**: Implemented \`tiptapToRichText\` function to convert TipTap editor JSON to \`DBRichTextPart\` format
- **Plain Text Conversion**: Added \`richTextToPlainText\` and \`userMessageToPlainText\` helper functions for Claude API compatibility
- **Message Submission**: Updated promptbox to submit messages in rich text format instead of plain text

### UI Components
- **RichTextPart Component**: Created new component that renders rich text with proper formatting:
  - File mentions displayed as pills with file icons (matching promptbox style)
  - Links highlighted in blue and clickable
  - Preserved newlines and whitespace
- **Message Part Updates**: Updated message-part.tsx to use RichTextPart for rich text rendering

### Type System Updates
- Added \`UIRichTextPart\` type to shared UI messages
- Updated \`UIUserMessage\` to support rich text parts
- Modified all \`handleSubmit\` signatures to accept rich text

## Test plan
- [x] Test creating messages with mentions (@filename)
- [x] Test creating messages with links
- [x] Test messages with multiple paragraphs and newlines
- [x] Verify mentions appear as pills in chat messages
- [x] Verify links are clickable and styled correctly
- [x] Confirm messages are sent to Claude as plain text
- [x] Check thread name generation works with rich text

Example 2:
## Summary
- Implements file upload functionality with drag-and-drop support
- Adds progress tracking and cancellation for large file uploads
- Integrates with R2 storage for secure file handling

## Changes

### File Upload Components
- **FileUploadZone**: New dropzone component with visual feedback
- **UploadProgress**: Real-time progress indicator with cancel button
- **FilePreview**: Thumbnail generation for images and file type icons

### Backend Integration
- **Upload API**: Created \`/api/upload\` endpoint with multipart support
- **R2 Storage**: Integrated Cloudflare R2 for file storage
- **File Validation**: Added size limits and type checking

### UI/UX Improvements
- Drag-and-drop visual feedback with overlay
- Toast notifications for upload status
- Keyboard navigation support

## Test plan
- [x] Upload various file types (images, documents, code)
- [x] Test drag-and-drop functionality
- [x] Verify file size limits are enforced
- [x] Test upload cancellation
- [x] Check error handling for network failures
`;

export async function generatePRContent({
  gitDiff,
  branchName,
  repoName,
  taskTitle,
}: {
  gitDiff: string;
  branchName: string;
  repoName: string;
  taskTitle: string;
}): Promise<{ title: string; body: string } | null> {
  if (!env.OPENAI_API_KEY) {
    return null;
  }
  // Original logic: generate both title and body
  const result = await generateObject({
    model: openai("gpt-5-nano"),
    schema: prContentSchema,
    prompt: `Based on the following information, generate a pull request title and body:

Task Title: ${taskTitle}
Repository: ${repoName}
Branch: ${branchName}

Git diff:
<git-diff>
${gitDiff}
</git-diff>

Generate a concise title (under 72 characters) and a well-structured PR body.

${examplePRBodies}

Follow this style and structure. Use markdown formatting effectively.`,
  });
  console.log("[ai/generateObject] response_id:", result.response?.id);
  return {
    title: (result.object as z.infer<typeof prContentSchema>).title,
    body: (result.object as z.infer<typeof prContentSchema>).body,
  };
}

export async function updatePRContent({
  gitDiff,
  branchName,
  repoName,
  currentTitle,
  currentBody,
  taskTitle,
}: {
  gitDiff: string;
  branchName: string;
  repoName: string;
  currentTitle: string;
  currentBody: string;
  taskTitle: string;
}): Promise<{ shouldUpdate: boolean; title?: string; body?: string }> {
  if (!env.OPENAI_API_KEY) {
    return { shouldUpdate: false };
  }
  const result = await generateObject({
    model: openai("gpt-5-nano"),
    schema: prUpdateSchema,
    prompt: `\
You are updating an existing pull request. Based on the updated changes and the current PR content, determine if the title/body should be updated. It is very important that the title and body accurately describe the changes.

Task Title: ${taskTitle}
Repository: ${repoName}
Branch: ${branchName}

Current PR Title:
<pr-title>
${currentTitle}
</pr-title>

Current PR Body:
<pr-body>
${currentBody}
</pr-body>

Updated Git diff:
<git-diff>
${gitDiff}
</git-diff>

${examplePRBodies}

Rules for updating:
1. We want to update if PR title and body no longer accurately describe the changes
2. The PR title and body should accurately describe the changes
3. The PR title should be concise (under 72 characters)
3. Keep the same style and structure as the current PR body
4. Preserve any task links, images, references, or metadata in the current body

If you determine an update is needed:
- Create a title and body that reflects the updated changes
- Keep the same formatting style as the original title and body

Remember: Only set shouldUpdate to true if the changes warrant updating the PR content.`,
  });
  console.log("[ai/generateObject] response_id:", result.response?.id);
  // If we're not updating, return the current content
  if (!(result.object as z.infer<typeof prUpdateSchema>).shouldUpdate) {
    return { shouldUpdate: false };
  }
  return {
    shouldUpdate: true,
    title: (result.object as z.infer<typeof prUpdateSchema>).title,
    body: (result.object as z.infer<typeof prUpdateSchema>).body,
  };
}
