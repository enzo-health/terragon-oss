import { nanoid } from "nanoid/non-secure";
import type { ThreadEvent } from "@openai/codex-sdk";
import { IDaemonRuntime } from "./runtime";
import { ClaudeMessage } from "./shared";

export type CodexItemEvent = Extract<
  ThreadEvent,
  { type: "item.started" | "item.updated" | "item.completed" }
>;

type CollabToolCallItem = {
  id: string;
  type: "collab_tool_call";
  tool?: string;
  sender_thread_id?: string;
  receiver_thread_ids?: string[];
  prompt?: string | null;
  agents_states?: Record<string, { status?: string; message?: string | null }>;
  status?: string;
};

export type CodexParserState = {
  activeTaskToolUseIds: string[];
};

export function createCodexParserState(): CodexParserState {
  return {
    activeTaskToolUseIds: [],
  };
}

function getActiveTaskToolUseId(state: CodexParserState): string | null {
  const activeTaskToolUseId =
    state.activeTaskToolUseIds[state.activeTaskToolUseIds.length - 1];
  return activeTaskToolUseId ?? null;
}

function addActiveTaskToolUseId({
  state,
  toolUseId,
}: {
  state: CodexParserState;
  toolUseId: string;
}): void {
  if (!state.activeTaskToolUseIds.includes(toolUseId)) {
    state.activeTaskToolUseIds.push(toolUseId);
  }
}

function removeActiveTaskToolUseId({
  state,
  toolUseId,
}: {
  state: CodexParserState;
  toolUseId: string;
}): void {
  state.activeTaskToolUseIds = state.activeTaskToolUseIds.filter(
    (activeToolUseId) => activeToolUseId !== toolUseId,
  );
}

function summarizeTaskDescription(prompt: string): string {
  const normalizedPrompt = prompt.replace(/\s+/g, " ").trim();
  if (!normalizedPrompt) {
    return "Delegated Codex sub-agent task";
  }
  if (normalizedPrompt.length <= 120) {
    return normalizedPrompt;
  }
  return `${normalizedPrompt.slice(0, 117)}...`;
}

function formatCollabToolCallResult(item: CollabToolCallItem): {
  content: string;
  isError: boolean;
} {
  const agentStateEntries = Object.entries(item.agents_states ?? {});
  const agentStateLines = agentStateEntries.map(([receiverThreadId, state]) => {
    const status = state.status ?? "unknown";
    const message = state.message?.trim();
    return message
      ? `- ${receiverThreadId}: ${status} (${message})`
      : `- ${receiverThreadId}: ${status}`;
  });
  const hasErroredAgentState = agentStateEntries.some(([, state]) => {
    const normalizedStatus = (state.status ?? "").toLowerCase();
    return (
      normalizedStatus === "errored" ||
      normalizedStatus === "failed" ||
      normalizedStatus === "not_found"
    );
  });
  const isError = item.status === "failed" || hasErroredAgentState;
  const heading = isError
    ? "Delegated Codex sub-agent task failed"
    : "Delegated Codex sub-agent task completed";
  return {
    content:
      agentStateLines.length > 0
        ? `${heading}\n${agentStateLines.join("\n")}`
        : heading,
    isError,
  };
}

function transformCollabToolCall({
  codexMsg,
  runtime,
  state,
}: {
  codexMsg: CodexItemEvent;
  runtime: IDaemonRuntime;
  state: CodexParserState;
}): ClaudeMessage[] {
  const item = codexMsg.item as unknown as CollabToolCallItem;
  if (item.tool !== "send_input") {
    return [];
  }

  const toolUseId = item.id;
  const taskPrompt =
    item.prompt?.trim() || "Complete the delegated sub-agent task.";
  const status = item.status;
  const activeParentToolUseId = getActiveTaskToolUseId(state);

  const shouldEmitTaskStart =
    !state.activeTaskToolUseIds.includes(toolUseId) &&
    (codexMsg.type === "item.started" ||
      (codexMsg.type === "item.updated" && status === "in_progress"));

  if (shouldEmitTaskStart) {
    addActiveTaskToolUseId({ state, toolUseId });
    return [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              name: "Task",
              id: toolUseId,
              input: {
                description: summarizeTaskDescription(taskPrompt),
                prompt: taskPrompt,
                subagent_type: "codex-subagent",
              },
            },
          ],
        },
        parent_tool_use_id: activeParentToolUseId,
        session_id: "",
      },
    ];
  }

  if (
    codexMsg.type === "item.completed" ||
    status === "completed" ||
    status === "failed"
  ) {
    removeActiveTaskToolUseId({ state, toolUseId });
    const completionParentToolUseId = getActiveTaskToolUseId(state);
    const { content, isError } = formatCollabToolCallResult(item);
    return [
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUseId,
              content,
              is_error: isError,
            },
          ],
        },
        parent_tool_use_id: completionParentToolUseId,
        session_id: "",
      },
    ];
  }

  runtime.logger.debug("Ignoring collab_tool_call update", {
    id: item.id,
    tool: item.tool,
    status,
    eventType: codexMsg.type,
  });
  return [];
}

function transformMcpToolCall({
  codexMsg,
  runtime,
  parentToolUseId,
}: {
  codexMsg: CodexItemEvent;
  runtime: IDaemonRuntime;
  parentToolUseId: string | null;
}): ClaudeMessage[] {
  const messages: ClaudeMessage[] = [];
  const item = codexMsg.item;
  if (item.type !== "mcp_tool_call") {
    return messages;
  }
  const toolUseId = item.id;
  const status = item.status;
  const server = item.server;
  const tool = item.tool;
  const itemData = item as {
    status?: string;
    result?: unknown;
    response?: unknown;
    output?: unknown;
    error?: unknown;
  };
  switch (status) {
    case "in_progress":
    case undefined: {
      messages.push({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              name: "MCPTool",
              input: { server, tool },
              id: toolUseId,
            },
          ],
        },
        parent_tool_use_id: parentToolUseId,
        session_id: "",
      });
      return messages;
    }
    case "completed":
    case "failed": {
      const resultPayload =
        itemData.result ?? itemData.response ?? itemData.output;
      const serializedResult =
        typeof resultPayload === "string"
          ? resultPayload
          : resultPayload
            ? JSON.stringify(resultPayload, null, 2)
            : `MCP tool ${server}::${tool} ${status}.`;
      const errorPayload =
        typeof itemData.error === "string"
          ? itemData.error
          : itemData.error
            ? JSON.stringify(itemData.error, null, 2)
            : null;
      const isError = status === "failed" || errorPayload !== null;
      const resultContent = errorPayload
        ? `Error from MCP tool ${server}::${tool}: ${errorPayload}`
        : serializedResult;
      messages.push({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUseId,
              content: resultContent,
              is_error: isError,
            },
          ],
        },
        parent_tool_use_id: parentToolUseId,
        session_id: "",
      });
      return messages;
    }
    default: {
      const _exhaustiveCheck: never = status;
      runtime.logger.warn("Unknown MCP tool status", {
        status: _exhaustiveCheck,
      });
      return messages;
    }
  }
}

function transformTodoListItem({
  codexMsg,
  eventType,
  runtime,
  parentToolUseId,
}: {
  codexMsg: CodexItemEvent;
  eventType: "item.started" | "item.updated" | "item.completed";
  runtime: IDaemonRuntime;
  parentToolUseId: string | null;
}): ClaudeMessage[] {
  const items =
    (codexMsg.item as { items?: Array<{ text: string; completed: boolean }> })
      .items ?? [];
  const formattedItems =
    items.length > 0
      ? items
          .map((item) => {
            const status = item.completed ? "x" : " ";
            return `- [${status}] ${item.text}`;
          })
          .join("\n")
      : "(empty)";

  if (eventType === "item.started") {
    const toolUseId = `${codexMsg.item.id}-read`;
    return [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              name: "TodoRead",
              input: {},
              id: toolUseId,
            },
          ],
        },
        parent_tool_use_id: parentToolUseId,
        session_id: "",
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUseId,
              content: `Current todo list:\n${formattedItems}`,
              is_error: false,
            },
          ],
        },
        parent_tool_use_id: parentToolUseId,
        session_id: "",
      },
    ];
  }

  if (eventType === "item.completed") {
    const toolUseId = `${codexMsg.item.id}-write`;
    const todos = items.map((item, index) => ({
      id: `${index + 1}`,
      content: item.text,
      status: (item.completed ? "completed" : "pending") as
        | "completed"
        | "pending"
        | "in_progress",
    }));
    return [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              name: "TodoWrite",
              input: { todos },
              id: toolUseId,
            },
          ],
        },
        parent_tool_use_id: parentToolUseId,
        session_id: "",
      },
      {
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUseId,
              content: `Updated todo list:\n${formattedItems}`,
              is_error: false,
            },
          ],
        },
        parent_tool_use_id: parentToolUseId,
        session_id: "",
      },
    ];
  }

  if (eventType === "item.updated") {
    runtime.logger.debug("Ignoring in-progress todo_list update", {
      itemId: codexMsg.item.id,
    });
    return [];
  }

  const _exhaustiveCheck: never = eventType;
  runtime.logger.warn("Unhandled todo_list event type", {
    type: _exhaustiveCheck,
  });
  return [];
}

type CodexReasoningEffort = "low" | "medium" | "high" | "xhigh";

type ResolvedCodexModel = {
  modelName: string;
  reasoningEffort: CodexReasoningEffort | null;
};

function resolveCodexModel(model: string): ResolvedCodexModel {
  switch (model) {
    case "gpt-5-low":
      return { modelName: "gpt-5", reasoningEffort: "low" };
    case "gpt-5-high":
      return { modelName: "gpt-5", reasoningEffort: "high" };
    case "gpt-5-codex-low":
      return { modelName: "gpt-5-codex", reasoningEffort: "low" };
    case "gpt-5-codex-medium":
      return { modelName: "gpt-5-codex", reasoningEffort: "medium" };
    case "gpt-5-codex-high":
      return { modelName: "gpt-5-codex", reasoningEffort: "high" };
    case "gpt-5.1-low":
      return { modelName: "gpt-5.1", reasoningEffort: "low" };
    case "gpt-5.1":
      return { modelName: "gpt-5.1", reasoningEffort: null };
    case "gpt-5.1-high":
      return { modelName: "gpt-5.1", reasoningEffort: "high" };
    case "gpt-5.1-codex-low":
      return { modelName: "gpt-5.1-codex", reasoningEffort: "low" };
    case "gpt-5.1-codex-medium":
      return { modelName: "gpt-5.1-codex", reasoningEffort: "medium" };
    case "gpt-5.1-codex-high":
      return { modelName: "gpt-5.1-codex", reasoningEffort: "high" };
    case "gpt-5.1-codex-max-low":
      return { modelName: "gpt-5.1-codex-max", reasoningEffort: "low" };
    case "gpt-5.1-codex-max":
      return { modelName: "gpt-5.1-codex-max", reasoningEffort: "medium" };
    case "gpt-5.1-codex-max-high":
      return { modelName: "gpt-5.1-codex-max", reasoningEffort: "high" };
    case "gpt-5.1-codex-max-xhigh":
      return { modelName: "gpt-5.1-codex-max", reasoningEffort: "xhigh" };
    case "gpt-5.2-low":
      return { modelName: "gpt-5.2", reasoningEffort: "low" };
    case "gpt-5.2":
      return { modelName: "gpt-5.2", reasoningEffort: "medium" };
    case "gpt-5.2-high":
      return { modelName: "gpt-5.2", reasoningEffort: "high" };
    case "gpt-5.2-xhigh":
      return { modelName: "gpt-5.2", reasoningEffort: "xhigh" };
    case "gpt-5.2-codex-low":
      return { modelName: "gpt-5.2-codex", reasoningEffort: "low" };
    case "gpt-5.2-codex-medium":
      return { modelName: "gpt-5.2-codex", reasoningEffort: "medium" };
    case "gpt-5.2-codex-high":
      return { modelName: "gpt-5.2-codex", reasoningEffort: "high" };
    case "gpt-5.2-codex-xhigh":
      return { modelName: "gpt-5.2-codex", reasoningEffort: "xhigh" };
    case "gpt-5.3-codex-low":
      return { modelName: "gpt-5.3-codex", reasoningEffort: "low" };
    case "gpt-5.3-codex-medium":
      return { modelName: "gpt-5.3-codex", reasoningEffort: "medium" };
    case "gpt-5.3-codex-high":
      return { modelName: "gpt-5.3-codex", reasoningEffort: "high" };
    case "gpt-5.3-codex-xhigh":
      return { modelName: "gpt-5.3-codex", reasoningEffort: "xhigh" };
    case "gpt-5.3-codex-spark-low":
      return { modelName: "gpt-5.3-codex-spark", reasoningEffort: "low" };
    case "gpt-5.3-codex-spark-medium":
      return { modelName: "gpt-5.3-codex-spark", reasoningEffort: "medium" };
    case "gpt-5.3-codex-spark-high":
      return { modelName: "gpt-5.3-codex-spark", reasoningEffort: "high" };
    case "gpt-5":
      return { modelName: "gpt-5", reasoningEffort: null };
    default:
      return { modelName: "gpt-5", reasoningEffort: null };
  }
}

export function codexAppServerStartCommand({
  model,
  useCredits = false,
}: {
  model: string;
  useCredits?: boolean;
}): [command: string, args: string[]] {
  const resolvedModel = resolveCodexModel(model);
  const args = [
    "app-server",
    "-c",
    `model="${resolvedModel.modelName}"`,
    "-c",
    'model_providers.openai.name="openai"',
  ];
  if (resolvedModel.reasoningEffort) {
    args.push(
      "-c",
      `model_reasoning_effort="${resolvedModel.reasoningEffort}"`,
    );
  }
  if (useCredits) {
    args.push("-c", 'model_provider="terry"');
  }
  return ["codex", args];
}

export type CodexThreadStartParams = {
  model: string;
  stream: true;
  instructions: string;
  sandboxPolicy: {
    type: "externalSandbox";
    networkAccess: "enabled";
  };
  approvalPolicy: "never";
  modelReasoningEffort?: CodexReasoningEffort;
};

export function buildThreadStartParams({
  model,
  instructions,
}: {
  model: string;
  instructions: string;
}): CodexThreadStartParams {
  const resolvedModel = resolveCodexModel(model);
  return {
    model: resolvedModel.modelName,
    ...(resolvedModel.reasoningEffort
      ? { modelReasoningEffort: resolvedModel.reasoningEffort }
      : {}),
    stream: true,
    instructions,
    sandboxPolicy: {
      type: "externalSandbox",
      networkAccess: "enabled",
    },
    approvalPolicy: "never",
  };
}

export type CodexTurnStartParams = {
  threadId: string;
  content: string;
};

export function buildTurnStartParams({
  threadId,
  prompt,
}: {
  threadId: string;
  prompt: string;
}): CodexTurnStartParams {
  return {
    threadId,
    content: prompt,
  };
}

/**
 * Create a command to run the Codex CLI with the given prompt.
 *
 * @param runtime - The daemon runtime
 * @param prompt - The prompt to send to Codex
 * @param model - The specific codex model to use
 * @param agentVersion - The version of the agent to use
 * @returns The shell command to execute
 */
export function codexCommand({
  runtime,
  prompt,
  model,
  sessionId,
  useCredits = false,
}: {
  runtime: IDaemonRuntime;
  prompt: string;
  model: string;
  sessionId: string | null;
  useCredits?: boolean;
}): string {
  // Write prompt to a file
  const tmpFileName = `/tmp/codex-prompt-${nanoid()}.txt`;
  runtime.writeFileSync(tmpFileName, prompt);
  const commandParts = [
    "cat",
    tmpFileName,
    "|",
    "codex",
    "exec",
    "--dangerously-bypass-approvals-and-sandbox",
    "--json",
  ];
  const isMultiAgentDisabled = isTruthyEnv(
    process.env.CODEX_DISABLE_MULTI_AGENT,
  );
  if (!isMultiAgentDisabled) {
    commandParts.push("-c", "features.multi_agent=true");
    commandParts.push("-c", "features.child_agents_md=true");
    commandParts.push("-c", "agents.max_threads=6");
    commandParts.push("-c", "suppress_unstable_features_warning=true");
  } else {
    runtime.logger.info(
      "Codex multi-agent disabled via CODEX_DISABLE_MULTI_AGENT",
    );
  }
  const resolvedModel = resolveCodexModel(model);
  commandParts.push(`--model ${resolvedModel.modelName}`);
  if (resolvedModel.reasoningEffort) {
    commandParts.push(
      `--config model_reasoning_effort=${resolvedModel.reasoningEffort}`,
    );
  }
  if (useCredits) {
    commandParts.push("-c", 'model_provider="terry"');
  }
  if (sessionId) {
    commandParts.push("resume", sessionId);
  }
  return commandParts.join(" ");
}

function isTruthyEnv(value: string | undefined): boolean {
  const normalizedValue = (value || "").trim().toLowerCase();
  return ["1", "true", "yes", "on", "enabled"].includes(normalizedValue);
}

/**
 * Parse a single line of Codex JSON output into ClaudeMessage format
 *
 * @param line - A single line of JSON output from Codex CLI
 * @param runtime - The daemon runtime
 * @returns An array of ClaudeMessages (empty if the line should be skipped)
 */
export function parseCodexLine({
  line,
  runtime,
  state,
}: {
  line: string;
  runtime: IDaemonRuntime;
  state?: CodexParserState;
}): ClaudeMessage[] {
  const messages: ClaudeMessage[] = [];
  const parserState = state ?? createCodexParserState();
  // Try to parse as JSON
  let codexMsg: ThreadEvent;
  try {
    codexMsg = JSON.parse(line);
  } catch (e) {
    if (isNonFatalCodexWarning(line)) {
      runtime.logger.warn("Ignoring non-fatal Codex warning", { line });
      return messages;
    }

    // Not JSON, treat as regular assistant text
    messages.push({
      type: "assistant",
      message: { role: "assistant", content: line },
      parent_tool_use_id: null,
      session_id: "",
    });
    return messages;
  }
  const msgType = (codexMsg as { type?: string }).type;
  switch (msgType) {
    case "thread.started": {
      parserState.activeTaskToolUseIds = [];
      messages.push({
        type: "system",
        subtype: "init",
        session_id: (codexMsg as { thread_id?: string }).thread_id || "",
        tools: [],
        mcp_servers: [],
      });
      return messages;
    }
    case "turn.started": {
      return messages;
    }
    case "turn.completed": {
      runtime.logger.debug("Codex token usage", {
        input_tokens: (codexMsg as { usage?: { input_tokens?: number } }).usage
          ?.input_tokens,
        cached_input_tokens: (
          codexMsg as { usage?: { cached_input_tokens?: number } }
        ).usage?.cached_input_tokens,
        output_tokens: (codexMsg as { usage?: { output_tokens?: number } })
          .usage?.output_tokens,
      });
      return messages;
    }
    case "turn.failed": {
      return messages;
    }
    case "item.started":
    case "item.updated":
    case "item.completed": {
      return parseCodexItem({
        codexMsg: codexMsg as CodexItemEvent,
        runtime,
        state: parserState,
      });
    }
    case "error": {
      const errorMessage =
        (codexMsg as { message?: string }).message ||
        "Codex reported an error.";
      if (isNonFatalCodexWarning(errorMessage)) {
        runtime.logger.warn("Ignoring non-fatal Codex error warning", {
          message: errorMessage,
        });
        return messages;
      }

      parserState.activeTaskToolUseIds = [];
      messages.push({
        type: "result",
        subtype: "error_during_execution",
        session_id: "",
        error: errorMessage,
        is_error: true,
        num_turns: 0,
        duration_ms: 0,
      });
      return messages;
    }
    default: {
      runtime.logger.warn("Unknown Codex message type", {
        type: msgType,
        msg: codexMsg,
      });
      // Unknown message type, treat as regular assistant text
      messages.push({
        type: "assistant",
        message: { role: "assistant", content: line },
        parent_tool_use_id: null,
        session_id: "",
      });
      return messages;
    }
  }
}

const CONVERSATION_LENGTH_WARNING_MESSAGE =
  "Long conversations and multiple compactions can cause the model to be less accurate";
const UNSTABLE_FEATURES_WARNING_MESSAGE = "Under-development features enabled";

function isNonFatalCodexWarning(message: string | undefined): boolean {
  if (!message) {
    return false;
  }

  const normalizedMessage = message.toLowerCase();
  return (
    normalizedMessage.includes(
      CONVERSATION_LENGTH_WARNING_MESSAGE.toLowerCase(),
    ) ||
    normalizedMessage.includes(UNSTABLE_FEATURES_WARNING_MESSAGE.toLowerCase())
  );
}

function formatWebSearchResults(rawResults: unknown, query: string): string {
  if (!rawResults || !Array.isArray(rawResults)) {
    return typeof rawResults === "string"
      ? rawResults
      : `Web search completed for query: ${query}`;
  }
  return rawResults
    .map((r: Record<string, unknown>, i: number) => {
      const title = typeof r.title === "string" ? r.title : `Result ${i + 1}`;
      const url = typeof r.url === "string" ? r.url : "";
      const snippet = typeof r.snippet === "string" ? r.snippet : "";
      return `${title}${url ? ` (${url})` : ""}${snippet ? `\n  ${snippet}` : ""}`;
    })
    .join("\n");
}

export function parseCodexItem({
  codexMsg,
  runtime,
  state,
}: {
  codexMsg: CodexItemEvent;
  runtime: IDaemonRuntime;
  state: CodexParserState;
}): ClaudeMessage[] {
  const messages: ClaudeMessage[] = [];
  const item = codexMsg.item as {
    id: string;
    type?: string;
    text?: string;
    status?: string;
    command?: string;
    aggregated_output?: string;
    exit_code?: number;
    changes?: Array<{ path: string }>;
    query?: string;
    message?: string;
    error?: unknown;
    results?: unknown;
  };
  const itemType = item.type;
  const eventType = codexMsg.type;
  const parentToolUseId = getActiveTaskToolUseId(state);
  // Handle different item types
  switch (itemType) {
    case "reasoning": {
      messages.push({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "thinking",
              thinking: item.text || "",
              signature: "codex-synthetic-signature",
            },
          ],
        },
        parent_tool_use_id: parentToolUseId,
        session_id: "",
      });
      return messages;
    }
    case "agent_message": {
      messages.push({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: item.text || "" }],
        },
        parent_tool_use_id: parentToolUseId,
        session_id: "",
      });
      return messages;
    }
    case "command_execution": {
      const toolUseId = item.id;
      const itemStatus = item.status;
      switch (itemStatus) {
        case "in_progress": {
          // Convert to Bash tool use
          const command = item.command || "";
          messages.push({
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  name: "Bash",
                  input: { command, description: `Execute: ${command}` },
                  id: toolUseId,
                },
              ],
            },
            parent_tool_use_id: parentToolUseId,
            session_id: "",
          });
          return messages;
        }
        case "completed": {
          const output = item.aggregated_output;
          const exitCode = item.exit_code;
          const resultContent =
            exitCode && exitCode !== 0
              ? `${output || "Command completed"}\n[exit code: ${exitCode}]`
              : output || "Command completed";
          messages.push({
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: toolUseId,
                  content: resultContent,
                  is_error: exitCode !== 0,
                },
              ],
            },
            parent_tool_use_id: parentToolUseId,
            session_id: "",
          });
          return messages;
        }
        case "failed": {
          const output = item.aggregated_output;
          messages.push({
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: toolUseId,
                  content: output || "Command failed",
                  is_error: true,
                },
              ],
            },
            parent_tool_use_id: parentToolUseId,
            session_id: "",
          });
          return messages;
        }
        case "declined": {
          const output = item.aggregated_output;
          messages.push({
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: toolUseId,
                  content: output || "Command declined by approval policy",
                  is_error: false,
                },
              ],
            },
            parent_tool_use_id: parentToolUseId,
            session_id: "",
          });
          return messages;
        }
        default: {
          runtime.logger.warn("Unknown Codex item status", {
            status: itemStatus,
          });
          return messages;
        }
      }
    }
    case "file_change": {
      const changes = item.changes ?? [];
      if (changes.length === 0) return messages;
      const toolUseId = item.id;
      const pathList = changes.map((c) => c.path);
      messages.push({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              name: "FileChange",
              id: toolUseId,
              input: {
                files: changes.map((c) => ({
                  path: c.path,
                  action: "modified",
                })),
              },
            },
          ],
        },
        parent_tool_use_id: parentToolUseId,
        session_id: "",
      });
      messages.push({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: toolUseId,
              content: pathList.join("\n"),
              is_error: false,
            },
          ],
        },
        parent_tool_use_id: parentToolUseId,
        session_id: "",
      });
      return messages;
    }
    case "web_search": {
      const toolUseId = item.id;
      const query = item.query || "";
      const rawResults = item.results;
      const status = item.status;
      switch (eventType) {
        case "item.started": {
          messages.push({
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  name: "WebSearch",
                  input: { query },
                  id: toolUseId,
                },
              ],
            },
            parent_tool_use_id: parentToolUseId,
            session_id: "",
          });
          return messages;
        }
        case "item.updated":
        case "item.completed": {
          const serializedResults = formatWebSearchResults(rawResults, query);
          const isError =
            status?.toLowerCase() === "failed" || item.error !== undefined;
          messages.push({
            type: "user",
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: toolUseId,
                  content: serializedResults,
                  is_error: isError,
                },
              ],
            },
            parent_tool_use_id: parentToolUseId,
            session_id: "",
          });
          return messages;
        }
        default: {
          const _exhaustiveCheck: never = eventType;
          runtime.logger.warn("Unhandled web_search event type", {
            type: _exhaustiveCheck,
          });
          return messages;
        }
      }
    }
    case "error": {
      const message = item.message || "Codex reported an error.";

      // There's a bug in codex where warnings are logged as errors in json mode.
      if (isNonFatalCodexWarning(message)) {
        // Log the warning but don't create an error result
        runtime.logger.warn("Ignoring non-fatal Codex item warning", {
          message,
        });
        return messages;
      }

      runtime.logger.warn("Codex item error", { message });
      messages.push({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        session_id: "",
        error: message,
        num_turns: 0,
        duration_ms: 0,
      });
      return messages;
    }
    case "mcp_tool_call": {
      return transformMcpToolCall({ codexMsg, runtime, parentToolUseId });
    }
    case "todo_list": {
      return transformTodoListItem({
        codexMsg,
        eventType,
        runtime,
        parentToolUseId,
      });
    }
    case "collab_tool_call": {
      return transformCollabToolCall({
        codexMsg,
        runtime,
        state,
      });
    }
    default: {
      runtime.logger.warn("Unknown Codex item type", {
        type: itemType,
      });
      return messages;
    }
  }
}
