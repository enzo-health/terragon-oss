import crypto from "node:crypto";
import { nanoid } from "nanoid/non-secure";
import type { ThreadMetaEvent } from "./codex-app-server";
import type { ClaudeMessage, DaemonDelta } from "./shared";
import { IDaemonRuntime } from "./runtime";
import { recordUnknownEvent } from "./unknown-event-telemetry";

export function getAnthropicApiKeyOrNull(runtime: IDaemonRuntime) {
  // Check if the user has Claude credentials.
  // If they do, we don't need to set the ANTHROPIC_API_KEY environment variable.
  // If they don't, we need to set it to the API key from the environment.
  const fallbackApiKey = process.env.ANTHROPIC_API_KEY ?? "";
  const cmd =
    "cd && test -f .claude/.credentials.json && echo 'EXISTS' || echo 'NOT_EXISTS'";
  if (runtime.execSync(cmd).trim() === "NOT_EXISTS") {
    return fallbackApiKey;
  }
  try {
    const homeDir = runtime.execSync("cd && pwd").trim();
    const credentials = runtime.readFileSync(
      `${homeDir}/.claude/.credentials.json`,
    );
    const credentialsJSON = JSON.parse(credentials);
    if (credentialsJSON.anthropicApiKey) {
      runtime.logger.info("Using anthropicApiKey from credentials file.");
      return credentialsJSON.anthropicApiKey;
    }
    runtime.logger.info("Not setting ANTHROPIC_API_KEY.");
    // Otherwise, the credentials file exists so we don't need to set the API key.
    return "";
  } catch (e) {
    runtime.logger.error("Error parsing credentials", { error: e });
    return fallbackApiKey;
  }
}

const toolUseErrorStr =
  "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

function isValidSessionId(runtime: IDaemonRuntime, sessionId: string) {
  try {
    // Look for the sessionId in ~/.claude/projects/**/<sessionId>.jsonl
    const homeDir = runtime.execSync("cd && pwd").trim();
    // Escape sessionId to prevent command injection
    const escapedSessionId = sessionId.replace(/[^a-zA-Z0-9._-]/g, "");
    const sessionLogFile = runtime
      .execSync(
        `find ${homeDir}/.claude/projects -name "${escapedSessionId}.jsonl"`,
      )
      .trim();
    if (!sessionLogFile) {
      runtime.logger.warn("No session log file found for sessionId", {
        sessionId,
      });
      return false;
    }
    return true;
  } catch (e) {
    runtime.logger.error("Error finding session log file", {
      sessionId,
    });
  }
  return false;
}

/**
 * If the user interrupted the tool use, we need to fix the logs otherwise claude doesn't know how to continue.
 * Every tool call needs a tool result.
 */
export function maybeFixLogsForSessionId(
  runtime: IDaemonRuntime,
  sessionId: string,
) {
  try {
    // Look for the sessionId in ~/.claude/projects/**/<sessionId>.jsonl
    const homeDir = runtime.execSync("cd && pwd").trim();
    // Escape sessionId to prevent command injection
    const escapedSessionId = sessionId.replace(/[^a-zA-Z0-9._-]/g, "");
    const sessionLogFile = runtime
      .execSync(
        `find ${homeDir}/.claude/projects -name "${escapedSessionId}.jsonl"`,
      )
      .trim();
    if (!sessionLogFile) {
      runtime.logger.warn("No session log file found for sessionId", {
        sessionId,
      });
      return;
    }
    const sessionLog = runtime.readFileSync(sessionLogFile);
    const sessionLogLines = sessionLog
      .split("\n")
      .filter((line) => line.trim());
    const sessionLogLinesParsed = sessionLogLines
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch (e) {
          return null;
        }
      })
      .filter(Boolean);

    let lastUuid: string | null = null;
    const lineByToolUseId: Record<string, any> = {};
    const toolUseIds = new Set<string>();
    const toolResultIds = new Set<string>();
    for (const line of sessionLogLinesParsed) {
      if (line.type === "assistant") {
        for (const part of line.message.content) {
          if (part.type === "tool_use") {
            toolUseIds.add(part.id);
            lineByToolUseId[part.id] = line;
          }
        }
      }
      if (line.type === "user") {
        for (const part of line.message.content) {
          if (part.type === "tool_result") {
            toolResultIds.add(part.tool_use_id);
          }
        }
      }
      lastUuid = line.uuid;
    }
    const toolUseIdsToFix = new Set<string>();
    for (const toolUseId of toolUseIds) {
      if (!toolResultIds.has(toolUseId)) {
        toolUseIdsToFix.add(toolUseId);
      }
    }
    // Nothing to fix.
    if (toolUseIdsToFix.size === 0) {
      return;
    }

    runtime.logger.info("Fixing tool use ids", {
      toolUseIdsToFix: Array.from(toolUseIdsToFix),
    });
    const logLinesToAppend = [];
    for (const toolUseId of toolUseIdsToFix) {
      const line = lineByToolUseId[toolUseId]!;
      const uuid = crypto.randomUUID();
      logLinesToAppend.push({
        ...line,
        parentUuid: lastUuid,
        uuid,
        type: "user",
        timestamp: new Date().toISOString(),
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              content: toolUseErrorStr,
              is_error: true,
              tool_use_id: toolUseId,
            },
          ],
        },
        toolUseResult: `Error: ${toolUseErrorStr}`,
      });
      lastUuid = uuid;
    }
    runtime.logger.info(
      `Appending ${logLinesToAppend.length} lines to ${sessionLogFile}`,
    );
    for (const line of logLinesToAppend) {
      runtime.appendFileSync(sessionLogFile, JSON.stringify(line) + "\n");
    }
    runtime.logger.info("Done fixing logs for sessionId", { sessionId });
  } catch (e) {
    runtime.logger.error("Error fixing logs for sessionId", {
      sessionId,
      error: e,
    });
  }
}

export function claudeCommand({
  runtime,
  prompt,
  sessionId,
  model,
  mcpConfigPath,
  permissionMode,
  enableMcpPermissionPrompt = false,
}: {
  runtime: IDaemonRuntime;
  prompt: string;
  sessionId: string | null;
  model: string;
  mcpConfigPath: string | null;
  permissionMode?: "allowAll" | "plan";
  enableMcpPermissionPrompt?: boolean;
}) {
  // Write prompt to a file.
  const tmpFileName = `/tmp/claude-prompt-${nanoid()}.txt`;
  runtime.writeFileSync(tmpFileName, prompt);

  let resumeOrContinueFlag = "";
  if (sessionId) {
    if (isValidSessionId(runtime, sessionId)) {
      resumeOrContinueFlag = `--resume ${sessionId}`;
    } else {
      runtime.logger.warn(
        "Using the continue flag instead because of invalid sessionId",
        {
          sessionId,
        },
      );
      resumeOrContinueFlag = "--continue";
    }
  }

  const parts = [
    "cat",
    tmpFileName,
    "|",
    "claude",
    "-p",
    "--model",
    model,
    resumeOrContinueFlag,
    "--verbose",
    ...(permissionMode === "plan"
      ? [
          "--permission-mode",
          "plan",
          "--allowedTools",
          "WebSearch",
          "WebFetch",
          "Read",
          "Bash",
        ]
      : ["--dangerously-skip-permissions"]),
    "--output-format",
    "stream-json",
    ...(mcpConfigPath ? ["--mcp-config", mcpConfigPath] : []),
    ...(enableMcpPermissionPrompt
      ? ["--permission-prompt-tool", "mcp__terry__PermissionPrompt"]
      : []),
    "--append-system-prompt",
    `"${systemPrompt}"`,
  ];
  return parts.join(" ");
}

const systemPrompt = `Your name is Terry and you are a coding agent that works for Terragon Labs. You can use the gh cli to interact with github. You are running as part of a system that might automatically commit and push changes to the remote for you. You can use the git commands to orient yourself.`;

// ---------------------------------------------------------------------------
// Sprint 4: Claude Code stream-json parser
// ---------------------------------------------------------------------------

/**
 * Parse an MCP tool name of the form `mcp__<server>__<tool>`.
 * Returns `null` if the name does not follow the pattern.
 * The server name is the segment between the first and second `__` pair;
 * the tool name is everything after the second `__`.
 */
export function parseMcpToolName(
  name: string,
): { server: string; tool: string } | null {
  if (!name.startsWith("mcp__")) return null;
  const rest = name.slice("mcp__".length); // "<server>__<tool>"
  const sepIdx = rest.indexOf("__");
  if (sepIdx < 1) return null; // must have a non-empty server segment
  const server = rest.slice(0, sepIdx);
  const tool = rest.slice(sepIdx + 2);
  if (!tool) return null;
  return { server, tool };
}

/**
 * A single streaming delta produced by the Claude Code stream parser.
 * This is a superset of `DaemonDelta` — it omits the run-state fields
 * (`threadId`, `threadChatId`, `token`, `deltaSeq`) which are filled in by
 * the caller from the active run context.
 */
export type ClaudeCodeDelta = Omit<DaemonDelta, "deltaSeq"> & {
  /** The content block index this delta belongs to (0-based). */
  blockIndex: number;
};

/**
 * A tool-call progress update produced when `input_json_delta` fragments
 * arrive before the tool_use block is finalised.
 */
export type ClaudeCodeToolProgress = {
  /** The `tool_use` block id this fragment belongs to. */
  toolUseId: string;
  /** Accumulated partial JSON so far. */
  accumulatedJson: string;
  /** The chunk to append. */
  chunk: string;
};

/**
 * The result of parsing a single Claude Code NDJSON line.
 */
export type ClaudeCodeParseResult = {
  /** Parsed chat messages (may be empty for stream-only events). */
  messages: ClaudeMessage[];
  /** Meta events to enqueue (session.initialized, usage.incremental, message.stop). */
  metaEvents: ThreadMetaEvent[];
  /** Streaming text/thinking deltas to push into the delta buffer. */
  deltas: ClaudeCodeDelta[];
  /** Tool-call partial JSON progress fragments. */
  toolProgress: ClaudeCodeToolProgress[];
};

/**
 * Stateful Claude Code stream parser.  One instance per agent run.
 *
 * Handles (Sprint 4):
 *   4.1  `system/init`            → `session.initialized` meta event
 *   4.2  `stream_event / content_block_delta / text_delta`    → text delta
 *   4.3  `stream_event / content_block_delta / input_json_delta` → tool progress
 *   4.4  `stream_event / content_block_delta / thinking_delta`   → thinking delta
 *   4.5  `stream_event / message_delta`  → `usage.incremental` + `message.stop`
 *   4.6  `assistant / tool_use` with `mcp__<server>__<tool>` name → mcpMetadata
 */
export class ClaudeCodeParser {
  /**
   * Accumulated partial JSON keyed by tool_use_id.
   * Used to collate `input_json_delta` fragments.
   */
  private readonly partialJsonByToolUseId = new Map<string, string>();

  /**
   * Parse a single raw NDJSON line emitted by `claude --output-format stream-json`.
   *
   * Returns an empty result (all arrays empty) when the line is unrecognised
   * or carries no actionable content.
   */
  parseClaudeCodeLine(line: string): ClaudeCodeParseResult {
    const result: ClaudeCodeParseResult = {
      messages: [],
      metaEvents: [],
      deltas: [],
      toolProgress: [],
    };

    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return result;
    }

    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return result;
    }

    const obj = parsed as Record<string, unknown>;
    const type = obj["type"] as string | undefined;

    switch (type) {
      // ------------------------------------------------------------------
      // Task 4.1: system/init → session.initialized meta event
      // ------------------------------------------------------------------
      case "system": {
        if (obj["subtype"] === "init") {
          const tools = Array.isArray(obj["tools"])
            ? (obj["tools"] as unknown[]).filter(
                (t): t is string => typeof t === "string",
              )
            : [];
          const mcpServerObjs = Array.isArray(obj["mcp_servers"])
            ? (obj["mcp_servers"] as unknown[])
            : [];
          const mcpServers = mcpServerObjs
            .filter(
              (s): s is Record<string, unknown> =>
                s !== null && typeof s === "object",
            )
            .map((s) => (typeof s["name"] === "string" ? s["name"] : ""))
            .filter((name) => name.length > 0);

          result.metaEvents.push({
            kind: "session.initialized",
            tools,
            mcpServers,
          });
        }
        // Always pass system/init through as a ClaudeMessage so downstream
        // handlers can update sessionId etc.
        result.messages.push(obj as unknown as ClaudeMessage);
        break;
      }

      // ------------------------------------------------------------------
      // Tasks 4.2, 4.3, 4.4, 4.5: stream_event
      // ------------------------------------------------------------------
      case "stream_event": {
        const event = obj["event"] as Record<string, unknown> | undefined;
        if (!event || typeof event !== "object") break;

        const eventType = event["type"] as string | undefined;

        if (eventType === "content_block_delta") {
          const blockIndex =
            typeof event["index"] === "number" ? event["index"] : 0;
          const delta = event["delta"] as Record<string, unknown> | undefined;
          if (!delta) break;
          const deltaType = delta["type"] as string | undefined;

          // Task 4.2: text_delta → text streaming delta
          if (deltaType === "text_delta") {
            const text = delta["text"] as string | undefined;
            if (text) {
              result.deltas.push({
                messageId: `block:${blockIndex}`,
                partIndex: blockIndex,
                blockIndex,
                kind: "text",
                text,
              });
            }
            break;
          }

          // Task 4.3: input_json_delta → tool-call progress
          if (deltaType === "input_json_delta") {
            const partialJson = delta["partial_json"] as string | undefined;
            if (partialJson !== undefined) {
              // We don't have a tool_use_id from stream_event alone —
              // use the block index as a synthetic key.
              const syntheticKey = `block_index:${blockIndex}`;
              const prev = this.partialJsonByToolUseId.get(syntheticKey) ?? "";
              const accumulated = prev + partialJson;
              this.partialJsonByToolUseId.set(syntheticKey, accumulated);
              result.toolProgress.push({
                toolUseId: syntheticKey,
                accumulatedJson: accumulated,
                chunk: partialJson,
              });
            }
            break;
          }

          // Task 4.4: thinking_delta → thinking streaming delta
          if (deltaType === "thinking_delta") {
            const thinking = delta["thinking"] as string | undefined;
            if (thinking) {
              result.deltas.push({
                messageId: `block:${blockIndex}`,
                partIndex: blockIndex,
                blockIndex,
                kind: "thinking",
                text: thinking,
              });
            }
            break;
          }

          // Unknown delta kind — record so we can see new Claude SDK features
          // (e.g. citations_delta) the moment Anthropic ships them instead of
          // waiting for user reports.
          recordUnknownEvent({
            transport: "claude-sdk",
            method: "stream_event/content_block_delta",
            itemType: deltaType ?? "<missing>",
            reason: "unhandled content_block_delta kind",
            payload: delta,
          });
        }

        // Task 4.5: message_delta → usage.incremental + message.stop
        if (eventType === "message_delta") {
          const delta = event["delta"] as Record<string, unknown> | undefined;
          const usage = event["usage"] as Record<string, unknown> | undefined;

          if (delta) {
            const stopReason = delta["stop_reason"] as string | undefined;
            if (stopReason) {
              result.metaEvents.push({
                kind: "message.stop",
                reason: stopReason,
              });
            }
          }

          if (usage) {
            result.metaEvents.push({
              kind: "usage.incremental",
              inputTokens:
                typeof usage["input_tokens"] === "number"
                  ? usage["input_tokens"]
                  : 0,
              outputTokens:
                typeof usage["output_tokens"] === "number"
                  ? usage["output_tokens"]
                  : 0,
              cacheCreation:
                typeof usage["cache_creation_input_tokens"] === "number"
                  ? usage["cache_creation_input_tokens"]
                  : 0,
              cacheRead:
                typeof usage["cache_read_input_tokens"] === "number"
                  ? usage["cache_read_input_tokens"]
                  : 0,
            });
          }
        }

        // Any eventType we didn't explicitly handle above (content_block_start,
        // content_block_stop, message_start, message_stop, etc.) falls through
        // here. Record so we know what Anthropic's SSE protocol is emitting
        // that we're not yet consuming.
        if (
          eventType !== "content_block_delta" &&
          eventType !== "message_delta"
        ) {
          recordUnknownEvent({
            transport: "claude-sdk",
            method: "stream_event",
            itemType: eventType ?? "<missing>",
            reason: "unhandled stream_event kind",
            payload: event,
          });
        }

        // stream_event lines are not surfaced as ClaudeMessage chat items.
        break;
      }

      // ------------------------------------------------------------------
      // Task 4.6: assistant messages — attach mcpMetadata to tool_use blocks
      // ------------------------------------------------------------------
      case "assistant": {
        const message = obj["message"] as Record<string, unknown> | undefined;
        if (message && Array.isArray(message["content"])) {
          const content = message["content"] as unknown[];
          for (const block of content) {
            if (
              block !== null &&
              typeof block === "object" &&
              (block as Record<string, unknown>)["type"] === "tool_use"
            ) {
              const b = block as Record<string, unknown>;
              const toolName = b["name"] as string | undefined;
              if (toolName) {
                const mcpMeta = parseMcpToolName(toolName);
                if (mcpMeta) {
                  b["mcpMetadata"] = mcpMeta;
                }
              }
            }
          }
        }
        result.messages.push(obj as unknown as ClaudeMessage);
        break;
      }

      // ------------------------------------------------------------------
      // All other message types (user, result, custom-stop, custom-error)
      // pass through as-is.
      // ------------------------------------------------------------------
      default: {
        result.messages.push(obj as unknown as ClaudeMessage);
        break;
      }
    }

    return result;
  }

  /**
   * Register a definitive tool_use_id → block index mapping once the
   * full `tool_use` block is received in an `assistant` message.
   * This allows callers to re-key accumulated JSON from the block-index
   * synthetic key to the real tool_use_id.
   */
  resolveToolUseId(blockIndex: number, toolUseId: string): string | undefined {
    const syntheticKey = `block_index:${blockIndex}`;
    const accumulated = this.partialJsonByToolUseId.get(syntheticKey);
    if (accumulated !== undefined) {
      this.partialJsonByToolUseId.set(toolUseId, accumulated);
      this.partialJsonByToolUseId.delete(syntheticKey);
    }
    return accumulated;
  }
}
