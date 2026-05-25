import { nanoid } from "nanoid/non-secure";
import { IDaemonRuntime } from "./runtime";
import { ClaudeMessage } from "./shared";

/**
 * Get the Factory Droid API key from the environment.
 * The key is passed from the sandbox environment variables.
 */
export function getDroidApiKeyOrNull(_runtime: IDaemonRuntime): string {
  return process.env.FACTORY_API_KEY ?? "";
}

/**
 * Droid `droid exec --output-format stream-json` line events.
 *
 * Pinned to the verified real CLI output (droid 0.132.1):
 *   {"type":"system","subtype":"init","session_id":...,"model":...,"tools":[...]}
 *   {"type":"message","role":"user"|"assistant","text":...,"id":...,"session_id":...}
 *   {"type":"reasoning","text":...,"session_id":...}            (intermediate; ignored)
 *   {"type":"tool_call","id":...,"toolId":...,"toolName":...,"parameters":{...}}
 *   {"type":"tool_result","id":...,"toolId":...,"isError":bool,"value":...}
 *   {"type":"completion","finalText":...,"numTurns":...,"durationMs":...,"usage":{...}}
 *   {"type":"error","message":...,"timestamp":...}
 */
type DroidEvent =
  | {
      type: "system";
      subtype?: string;
      session_id?: string;
      model?: string;
      tools?: string[];
    }
  | {
      type: "message";
      role?: "user" | "assistant";
      text?: string;
      id?: string;
      session_id?: string;
    }
  | { type: "reasoning"; text?: string; session_id?: string }
  | {
      type: "tool_call";
      id?: string;
      toolName?: string;
      toolId?: string;
      parameters?: Record<string, unknown>;
      session_id?: string;
    }
  | {
      type: "tool_result";
      id?: string;
      toolId?: string;
      isError?: boolean;
      value?: unknown;
      session_id?: string;
    }
  | {
      type: "completion";
      finalText?: string;
      numTurns?: number;
      durationMs?: number;
      session_id?: string;
    }
  | { type: "error"; message?: string; error?: unknown; session_id?: string }
  | { type: string; session_id?: string };

/**
 * Parse a line of JSON output from the Droid CLI (`--output-format stream-json`).
 * Transforms Droid stream events into the shared ClaudeMessage format.
 *
 * Mapping (pinned to verified real output):
 * - system/init  -> system init message (also synthesized on the first event seen)
 * - message (assistant) -> assistant text message (user echo events are ignored)
 * - reasoning    -> ignored (intermediate)
 * - tool_call    -> assistant tool_use message
 * - tool_result  -> user tool_result message (is_error from `isError`)
 * - completion   -> result/success terminal message
 * - error        -> result/error_during_execution terminal message
 *
 * Tolerates non-JSON and unknown event types without throwing. On malformed or
 * unknown input it logs only the event type / severity (never prompt text, tool
 * payloads, or credentials) and returns an empty array.
 *
 * @param line - A line of JSON output from droid exec
 * @param runtime - The daemon runtime for logging
 * @param isWorking - Whether the agent has already emitted a system init
 * @returns Array of ClaudeMessage objects
 */
export function parseDroidLine({
  line,
  runtime,
  isWorking,
}: {
  line: string;
  runtime: IDaemonRuntime;
  isWorking: boolean;
}): ClaudeMessage[] {
  const messages: ClaudeMessage[] = [];

  let event: DroidEvent;
  try {
    event = JSON.parse(line) as DroidEvent;
  } catch {
    // No PHI in logs: never log the raw line, only that a parse failed.
    runtime.logger.error("Failed to parse Droid output line");
    return messages;
  }

  if (!event || typeof event !== "object" || typeof event.type !== "string") {
    runtime.logger.warn("Droid event missing type discriminant");
    return messages;
  }

  const eventType = event.type;
  const sessionId = event.session_id ?? "";

  // Synthesize a system/init on the first event we see so downstream state
  // transitions to "working" even if init arrives interleaved.
  const emitInitIfNeeded = (tools: string[]): void => {
    if (isWorking) {
      return;
    }
    messages.push({
      type: "system",
      subtype: "init",
      session_id: sessionId,
      tools,
      mcp_servers: [],
    });
  };

  switch (eventType) {
    case "system": {
      const systemEvent = event as Extract<DroidEvent, { type: "system" }>;
      emitInitIfNeeded(systemEvent.tools ?? []);
      return messages;
    }

    case "message": {
      const messageEvent = event as Extract<DroidEvent, { type: "message" }>;
      // Ignore the echoed user prompt; only the assistant turn is normalized.
      if (messageEvent.role !== "assistant") {
        return messages;
      }
      const text = messageEvent.text;
      if (!text) {
        return messages;
      }
      emitInitIfNeeded([]);
      messages.push({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text }],
        },
        parent_tool_use_id: null,
        session_id: sessionId,
      });
      return messages;
    }

    case "reasoning": {
      // Intermediate event; do not surface reasoning text downstream.
      return messages;
    }

    case "tool_call": {
      const toolEvent = event as Extract<DroidEvent, { type: "tool_call" }>;
      const toolUseId = toolEvent.id ?? toolEvent.toolId ?? "";
      const toolName = toolEvent.toolName ?? toolEvent.toolId ?? "";
      if (!toolUseId || !toolName) {
        runtime.logger.warn("Droid tool_call missing id or name", {
          type: eventType,
        });
        return messages;
      }
      emitInitIfNeeded([]);
      messages.push({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: toolUseId,
              name: toolName,
              input: toolEvent.parameters ?? {},
            },
          ],
        },
        parent_tool_use_id: null,
        session_id: sessionId,
      });
      return messages;
    }

    case "tool_result": {
      const resultEvent = event as Extract<DroidEvent, { type: "tool_result" }>;
      const toolUseId = resultEvent.id ?? resultEvent.toolId ?? "";
      if (!toolUseId) {
        runtime.logger.warn("Droid tool_result missing id", {
          type: eventType,
        });
        return messages;
      }
      const isError = resultEvent.isError === true;
      const rawValue = resultEvent.value;
      const content =
        typeof rawValue === "string"
          ? rawValue
          : JSON.stringify(rawValue ?? "");
      messages.push({
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
        parent_tool_use_id: null,
        session_id: sessionId,
      });
      return messages;
    }

    case "completion": {
      const completionEvent = event as Extract<
        DroidEvent,
        { type: "completion" }
      >;
      messages.push({
        type: "result",
        subtype: "success",
        session_id: sessionId,
        is_error: false,
        num_turns: completionEvent.numTurns ?? 1,
        duration_ms: completionEvent.durationMs ?? 0,
        duration_api_ms: completionEvent.durationMs ?? 0,
        total_cost_usd: 0,
        result: completionEvent.finalText ?? "Task completed successfully",
      });
      return messages;
    }

    case "error": {
      const errorEvent = event as Extract<DroidEvent, { type: "error" }>;
      const errorMessage =
        errorEvent.message ??
        (typeof errorEvent.error === "string"
          ? errorEvent.error
          : errorEvent.error
            ? JSON.stringify(errorEvent.error)
            : "Unknown error");
      // No PHI in logs: log only the event type/severity.
      runtime.logger.warn("Droid error event", { type: eventType });
      messages.push({
        type: "result",
        subtype: "error_during_execution",
        session_id: sessionId,
        error: errorMessage,
        is_error: true,
        num_turns: 0,
        duration_ms: 0,
      });
      return messages;
    }

    default: {
      runtime.logger.debug("Unknown Droid event type, ignoring", {
        type: eventType,
      });
      return messages;
    }
  }
}

/**
 * Create a command to run the Droid CLI with the given prompt.
 *
 * The command format is:
 *   cat <prompt_file> | droid exec --output-format stream-json -m <model> \
 *     [-s <sessionId>] --skip-permissions-unsafe
 *
 * The prompt is written to a temporary file and piped via stdin so it never
 * appears in the command string (no PHI / prompt text in process args or logs).
 *
 * @param runtime - The daemon runtime
 * @param prompt - The prompt to send to Droid
 * @param model - The Droid model id
 * @param sessionId - Existing session id to resume, or null
 * @returns The shell command to execute
 */
export function droidCommand({
  runtime,
  prompt,
  model,
  sessionId,
}: {
  runtime: IDaemonRuntime;
  prompt: string;
  model: string;
  sessionId: string | null;
}): string {
  const tmpFileName = `/tmp/droid-prompt-${nanoid()}.txt`;
  runtime.writeFileSync(tmpFileName, prompt);
  const parts = [
    "cat",
    tmpFileName,
    "|",
    "droid",
    "exec",
    "--output-format",
    "stream-json",
    "-m",
    model,
  ];
  if (sessionId) {
    parts.push("-s", sessionId);
  }
  parts.push("--skip-permissions-unsafe");
  return parts.join(" ");
}
