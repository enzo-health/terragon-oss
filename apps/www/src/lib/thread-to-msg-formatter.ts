import { DBMessage, DBUserMessage } from "@leo/shared";
import {
  convertToPlainText,
  convertToPrompt,
  getUserMessageToSend,
  ConvertToPromptOptions,
} from "./db-message-helpers";

/**
 * Formats thread history to include all past messages including tool calls.
 * This provides full conversation context including what tools were used and their results.
 *
 * Format:
 * Human: {user message}
 *
 * Assistant: {assistant message}
 *
 * Tool Call: {tool name} with {parameters}
 *
 * Tool Result: {result}
 */
export async function formatThreadToMsg(
  messages: DBMessage[],
  options?: ConvertToPromptOptions,
): Promise<string> {
  let startIndex = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message) continue;
    if (
      message.type === "system" &&
      message.message_type === "compact-result"
    ) {
      startIndex = i;
      break;
    }
    if (message.type === "system" && message.message_type === "clear-context") {
      startIndex = i + 1;
      break;
    }
  }

  // Only process messages after the last context reset
  const messagesToProcess =
    startIndex >= 0 ? messages.slice(startIndex) : messages;
  const formattedParts: string[] = [];

  for (const message of messagesToProcess) {
    if (message.type === "user") {
      const userText = await formatUserMessage(message, options);
      if (userText) {
        formattedParts.push(`User: ${userText}`);
      }
    } else if (message.type === "agent") {
      const agentText = formatAgentMessage(message);
      if (agentText) {
        formattedParts.push(`Assistant: ${agentText}`);
      }
    } else if (message.type === "tool-call") {
      const toolCallText = formatToolCall(message);
      if (toolCallText) {
        formattedParts.push(toolCallText);
      }
    } else if (message.type === "tool-result") {
      const toolResultText = formatToolResult(message);
      if (toolResultText) {
        formattedParts.push(toolResultText);
      }
    } else if (message.type === "system") {
      const userMessageToSend = getUserMessageToSend({
        messages: [message],
        currentMessage: null,
      });
      if (userMessageToSend) {
        const userText = await formatUserMessage(userMessageToSend, options);
        if (userText) {
          formattedParts.push(`User: ${userText}`);
        }
      }
    }
    // Skip error and other message types like stop, meta, git-diff
  }

  return formattedParts.join("\n\n");
}

async function formatUserMessage(
  message: DBUserMessage,
  options?: ConvertToPromptOptions,
): Promise<string> {
  if (options) {
    // If we have options (file writing capability), use convertToPrompt to handle images
    return await convertToPrompt(message, options);
  } else {
    // Otherwise, convert to plain text without downloading images
    return convertToPlainText({ message });
  }
}

function formatAgentMessage(
  message: Extract<DBMessage, { type: "agent" }>,
): string {
  const textParts: string[] = [];

  for (const part of message.parts) {
    if (part.type === "text") {
      textParts.push(part.text);
    }
    // Skip thinking parts for thread history
  }

  return textParts.join("\n");
}

function formatToolCall(
  message: Extract<DBMessage, { type: "tool-call" }>,
): string {
  const { name, parameters } = message;

  // Format parameters nicely
  let paramStr = "";
  if (parameters && Object.keys(parameters).length > 0) {
    // For simple parameters, show them inline
    const paramEntries = Object.entries(parameters);
    if (
      paramEntries.length <= 3 &&
      paramEntries.every(([_, v]) => typeof v !== "object")
    ) {
      paramStr = paramEntries.map(([k, v]) => `${k}="${v}"`).join(", ");
      return `Tool Call: ${name}(${paramStr})`;
    } else {
      // For complex parameters, show them as JSON
      paramStr = JSON.stringify(parameters, null, 2);
      return `Tool Call: ${name}\nParameters: ${paramStr}`;
    }
  }

  return `Tool Call: ${name}()`;
}

function formatToolResult(
  message: Extract<DBMessage, { type: "tool-result" }>,
): string {
  const { result, is_error } = message;

  if (is_error) {
    return `Tool Error: ${result}`;
  }

  // Truncate very long results
  const maxLength = 1000;
  const resultStr =
    typeof result === "string" ? result : JSON.stringify(result, null, 2);

  if (resultStr.length > maxLength) {
    return `Tool Result: ${resultStr.substring(0, maxLength)}... [truncated]`;
  }

  return `Tool Result: ${resultStr}`;
}
