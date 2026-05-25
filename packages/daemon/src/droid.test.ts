import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { droidCommand, getDroidApiKeyOrNull, parseDroidLine } from "./droid";
import { IDaemonRuntime } from "./runtime";
import { nanoid } from "nanoid/non-secure";

// Mock nanoid to return predictable values
vi.mock("nanoid/non-secure", () => ({
  nanoid: vi.fn(() => "test-nanoid-123"),
}));

// Fixtures captured from real `droid exec --output-format stream-json` output
// (droid CLI 0.132.1). Do NOT hand-write these from the JSON-RPC schema.
const SESSION_ID = "43effc75-0ba2-4923-9d13-35b1082200f7";

const INIT_LINE = JSON.stringify({
  type: "system",
  subtype: "init",
  cwd: "/private/tmp",
  session_id: SESSION_ID,
  tools: ["Read", "LS", "Execute", "Edit"],
  model: "claude-opus-4-7",
  reasoning_effort: "high",
});

const USER_ECHO_LINE = JSON.stringify({
  type: "message",
  role: "user",
  id: "f439ced8-5b77-45e4-b743-cbc2efe3f666",
  text: "Run the shell command 'echo hi'.",
  timestamp: 1779689764874,
  session_id: SESSION_ID,
});

const REASONING_LINE = JSON.stringify({
  type: "reasoning",
  id: "92cb5f6f-237a-461f-98d6-8b283fc82761",
  text: "The user wants me to run the shell command.",
  timestamp: 1779689766478,
  session_id: SESSION_ID,
});

const ASSISTANT_TEXT_LINE = JSON.stringify({
  type: "message",
  role: "assistant",
  id: "6493c8d7-a229-48b3-ae22-4f751688d4d4",
  text: "The output of the command is:\n\n**hi**",
  timestamp: 1779689767524,
  session_id: SESSION_ID,
});

const TOOL_CALL_LINE = JSON.stringify({
  type: "tool_call",
  id: "tc-12c8kfwtl53",
  messageId: "92cb5f6f-237a-461f-98d6-8b283fc82761",
  toolId: "Execute",
  toolName: "Execute",
  parameters: {
    summary: "Run echo hi command",
    command: "echo hi",
    riskLevel: "low",
  },
  timestamp: 1779689766478,
  session_id: SESSION_ID,
});

const TOOL_RESULT_SUCCESS_LINE = JSON.stringify({
  type: "tool_result",
  id: "tc-12c8kfwtl53",
  messageId: "16d5c510-4121-48ac-90ea-55c2be673fda",
  toolId: "Execute",
  isError: false,
  value: "hi\n\n\n[Process exited with code 0]",
  timestamp: 1779689766658,
  session_id: SESSION_ID,
});

const TOOL_RESULT_ERROR_LINE = JSON.stringify({
  type: "tool_result",
  id: "tc-errcall",
  toolId: "Execute",
  isError: true,
  value: "command not found: nope",
  timestamp: 1779689766658,
  session_id: SESSION_ID,
});

const COMPLETION_LINE = JSON.stringify({
  type: "completion",
  finalText: "The output of the command is:\n\n**hi**",
  numTurns: 2,
  durationMs: 2984,
  session_id: SESSION_ID,
  timestamp: 1779689767749,
  usage: {
    input_tokens: 28908,
    output_tokens: 152,
    cache_read_input_tokens: 18432,
    cache_creation_input_tokens: 0,
  },
});

const ERROR_LINE = JSON.stringify({
  type: "error",
  message: "Model request failed",
  timestamp: 1779689767749,
  session_id: SESSION_ID,
});

describe("droid", () => {
  let runtime: IDaemonRuntime;

  beforeEach(() => {
    runtime = {
      writeFileSync: vi.fn(),
      logger: {
        error: vi.fn(),
        debug: vi.fn(),
        info: vi.fn(),
        warn: vi.fn(),
      },
    } as unknown as IDaemonRuntime;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("getDroidApiKeyOrNull", () => {
    it("returns FACTORY_API_KEY from the environment", () => {
      const original = process.env.FACTORY_API_KEY;
      process.env.FACTORY_API_KEY = "test-factory-key";
      try {
        expect(getDroidApiKeyOrNull(runtime)).toBe("test-factory-key");
      } finally {
        if (original === undefined) {
          delete process.env.FACTORY_API_KEY;
        } else {
          process.env.FACTORY_API_KEY = original;
        }
      }
    });

    it("returns an empty string (never throws) when unset", () => {
      const original = process.env.FACTORY_API_KEY;
      delete process.env.FACTORY_API_KEY;
      try {
        expect(getDroidApiKeyOrNull(runtime)).toBe("");
      } finally {
        if (original !== undefined) {
          process.env.FACTORY_API_KEY = original;
        }
      }
    });
  });

  describe("droidCommand", () => {
    it("writes the prompt to a temp file and builds the pipeline", () => {
      const command = droidCommand({
        runtime,
        prompt: "do the thing",
        model: "claude-opus-4-7",
        sessionId: null,
      });

      expect(runtime.writeFileSync).toHaveBeenCalledWith(
        "/tmp/droid-prompt-test-nanoid-123.txt",
        "do the thing",
      );
      expect(command).toBe(
        "cat /tmp/droid-prompt-test-nanoid-123.txt | droid exec --output-format stream-json -m claude-opus-4-7 --skip-permissions-unsafe",
      );
    });

    it("keeps the prompt out of the command string (R18)", () => {
      const command = droidCommand({
        runtime,
        prompt: "SECRET PATIENT NAME",
        model: "claude-opus-4-7",
        sessionId: null,
      });
      expect(command).not.toContain("SECRET PATIENT NAME");
    });

    it("appends -s <sessionId> when resuming", () => {
      const command = droidCommand({
        runtime,
        prompt: "continue",
        model: "gpt-5.5",
        sessionId: "sess-abc",
      });
      expect(command).toBe(
        "cat /tmp/droid-prompt-test-nanoid-123.txt | droid exec --output-format stream-json -m gpt-5.5 -s sess-abc --skip-permissions-unsafe",
      );
    });

    it("uses a unique nanoid-based temp file name", () => {
      droidCommand({
        runtime,
        prompt: "p",
        model: "m",
        sessionId: null,
      });
      expect(nanoid).toHaveBeenCalled();
    });
  });

  describe("parseDroidLine", () => {
    it("parses system/init into a system init message", () => {
      const results = parseDroidLine({
        line: INIT_LINE,
        runtime,
        isWorking: false,
      });
      expect(results).toEqual([
        {
          type: "system",
          subtype: "init",
          session_id: SESSION_ID,
          tools: ["Read", "LS", "Execute", "Edit"],
          mcp_servers: [],
        },
      ]);
    });

    it("does not re-emit system/init once already working", () => {
      const results = parseDroidLine({
        line: INIT_LINE,
        runtime,
        isWorking: true,
      });
      expect(results).toEqual([]);
    });

    it("parses assistant text into an assistant message", () => {
      const results = parseDroidLine({
        line: ASSISTANT_TEXT_LINE,
        runtime,
        isWorking: true,
      });
      expect(results).toEqual([
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "The output of the command is:\n\n**hi**" },
            ],
          },
          parent_tool_use_id: null,
          session_id: SESSION_ID,
        },
      ]);
    });

    it("ignores the echoed user message", () => {
      const results = parseDroidLine({
        line: USER_ECHO_LINE,
        runtime,
        isWorking: true,
      });
      expect(results).toEqual([]);
    });

    it("ignores intermediate reasoning events", () => {
      const results = parseDroidLine({
        line: REASONING_LINE,
        runtime,
        isWorking: true,
      });
      expect(results).toEqual([]);
    });

    it("parses tool_call into an assistant tool_use message", () => {
      const results = parseDroidLine({
        line: TOOL_CALL_LINE,
        runtime,
        isWorking: true,
      });
      expect(results).toEqual([
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "tc-12c8kfwtl53",
                name: "Execute",
                input: {
                  summary: "Run echo hi command",
                  command: "echo hi",
                  riskLevel: "low",
                },
              },
            ],
          },
          parent_tool_use_id: null,
          session_id: SESSION_ID,
        },
      ]);
    });

    it("parses a successful tool_result into a user tool_result message", () => {
      const results = parseDroidLine({
        line: TOOL_RESULT_SUCCESS_LINE,
        runtime,
        isWorking: true,
      });
      expect(results).toEqual([
        {
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tc-12c8kfwtl53",
                content: "hi\n\n\n[Process exited with code 0]",
                is_error: false,
              },
            ],
          },
          parent_tool_use_id: null,
          session_id: SESSION_ID,
        },
      ]);
    });

    it("parses an errored tool_result with is_error true", () => {
      const results = parseDroidLine({
        line: TOOL_RESULT_ERROR_LINE,
        runtime,
        isWorking: true,
      });
      expect(results).toEqual([
        {
          type: "user",
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "tc-errcall",
                content: "command not found: nope",
                is_error: true,
              },
            ],
          },
          parent_tool_use_id: null,
          session_id: SESSION_ID,
        },
      ]);
    });

    it("parses completion into a result/success message", () => {
      const results = parseDroidLine({
        line: COMPLETION_LINE,
        runtime,
        isWorking: true,
      });
      expect(results).toEqual([
        {
          type: "result",
          subtype: "success",
          session_id: SESSION_ID,
          is_error: false,
          num_turns: 2,
          duration_ms: 2984,
          duration_api_ms: 2984,
          total_cost_usd: 0,
          result: "The output of the command is:\n\n**hi**",
        },
      ]);
    });

    it("parses an error event into a result/error_during_execution message", () => {
      const results = parseDroidLine({
        line: ERROR_LINE,
        runtime,
        isWorking: true,
      });
      expect(results).toEqual([
        {
          type: "result",
          subtype: "error_during_execution",
          session_id: SESSION_ID,
          error: "Model request failed",
          is_error: true,
          num_turns: 0,
          duration_ms: 0,
        },
      ]);
      // R18: error logging records only the event type, never the message body.
      expect(runtime.logger.warn).toHaveBeenCalledWith("Droid error event", {
        type: "error",
      });
    });

    it("returns [] for malformed (non-JSON) lines without throwing", () => {
      expect(() =>
        parseDroidLine({ line: "not json {{{", runtime, isWorking: true }),
      ).not.toThrow();
      const results = parseDroidLine({
        line: "not json {{{",
        runtime,
        isWorking: true,
      });
      expect(results).toEqual([]);
      expect(runtime.logger.error).toHaveBeenCalledWith(
        "Failed to parse Droid output line",
      );
    });

    it("does not log raw line content on parse failure (R18)", () => {
      parseDroidLine({
        line: '{"type": malformed PATIENT_SECRET',
        runtime,
        isWorking: true,
      });
      const errorCalls = (runtime.logger.error as ReturnType<typeof vi.fn>).mock
        .calls;
      for (const call of errorCalls) {
        expect(JSON.stringify(call)).not.toContain("PATIENT_SECRET");
      }
    });

    it("returns [] for unknown event types without throwing", () => {
      const line = JSON.stringify({
        type: "totally_unknown_event",
        session_id: SESSION_ID,
      });
      const results = parseDroidLine({ line, runtime, isWorking: true });
      expect(results).toEqual([]);
      expect(runtime.logger.debug).toHaveBeenCalledWith(
        "Unknown Droid event type, ignoring",
        { type: "totally_unknown_event" },
      );
    });

    it("synthesizes a system/init when the first event is not init", () => {
      const results = parseDroidLine({
        line: ASSISTANT_TEXT_LINE,
        runtime,
        isWorking: false,
      });
      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({
        type: "system",
        subtype: "init",
        session_id: SESSION_ID,
        tools: [],
        mcp_servers: [],
      });
      expect(results[1]?.type).toBe("assistant");
    });
  });
});
