import {
  DAEMON_CAPABILITY_EVENT_ENVELOPE_V2,
  DAEMON_EVENT_CAPABILITIES_HEADER,
  type ClaudeMessage,
  type DaemonEventAPIBody,
} from "@terragon/daemon/shared";
import { getAgentRunContextByRunId } from "@terragon/shared/model/agent-run-context";
import { db } from "@/lib/db";
import {
  buildDeltaBatch,
  buildMessagesBatch,
  createEmulatorRunState,
  EMULATOR_SESSION_ID,
  type EmulatorRunState,
} from "./daemon-batches";
import { resolveEmulatorPacing } from "./enabled";
import {
  type EmulatorScenario,
  type EmulatorStep,
  terminalMessages,
} from "./scenarios";

const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "stopped"]);

type RoutePostHandler = (request: Request) => Promise<Response>;
let cachedRouteHandler: RoutePostHandler | null = null;

async function getRouteHandler(): Promise<RoutePostHandler> {
  if (!cachedRouteHandler) {
    const mod = await import("@/app/api/daemon-event/route");
    cachedRouteHandler = mod.POST;
  }
  return cachedRouteHandler;
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export function applyRunScopedStepIds(
  steps: EmulatorStep[],
  runId: string,
): EmulatorStep[] {
  return steps.map((step) => {
    switch (step.type) {
      case "thinking":
      case "text":
        return { ...step, messageId: `${step.messageId}-${runId}` };
      case "tool-call":
        return { ...step, toolCallId: `${step.toolCallId}-${runId}` };
      default:
        return step;
    }
  });
}

function chunkText(text: string, chunkChars: number): string[] {
  const chunks: string[] = [];
  for (let index = 0; index < text.length; index += chunkChars) {
    chunks.push(text.slice(index, index + chunkChars));
  }
  return chunks.length > 0 ? chunks : [""];
}

function systemInitMessage(): ClaudeMessage {
  return {
    type: "system",
    subtype: "init",
    session_id: EMULATOR_SESSION_ID,
    tools: ["Bash", "Read", "Edit", "Write"],
    mcp_servers: [],
  };
}

function toolCallStartMessage(params: {
  toolCallId: string;
  name: string;
  input: Record<string, unknown>;
}): ClaudeMessage {
  return {
    type: "assistant",
    parent_tool_use_id: null,
    session_id: EMULATOR_SESSION_ID,
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: params.toolCallId,
          name: params.name,
          input: params.input,
        },
      ],
    },
  };
}

function toolCallResultMessage(params: {
  toolCallId: string;
  result: string;
  isError: boolean;
}): ClaudeMessage {
  return {
    type: "user",
    parent_tool_use_id: null,
    session_id: EMULATOR_SESSION_ID,
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: params.toolCallId,
          content: params.result,
          is_error: params.isError,
        },
      ],
    },
  };
}

type RunHaltStatus = "live" | "stopped" | "terminal" | "missing";

async function getRunHaltStatus(params: {
  runId: string;
  userId: string;
}): Promise<RunHaltStatus> {
  try {
    const runContext = await getAgentRunContextByRunId({
      db,
      runId: params.runId,
      userId: params.userId,
    });
    if (!runContext) {
      return "missing";
    }
    if (runContext.status === "stopped") {
      return "stopped";
    }
    if (TERMINAL_RUN_STATUSES.has(runContext.status)) {
      return "terminal";
    }
    return "live";
  } catch (error) {
    console.warn("[agent-emulator] halt poll failed, continuing", {
      runId: params.runId,
      error,
    });
    return "live";
  }
}

async function postBatch(params: {
  body: DaemonEventAPIBody;
  token: string;
}): Promise<{ status: number; ok: boolean }> {
  const handler = await getRouteHandler();
  const request = new Request("http://localhost/api/daemon-event", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Daemon-Token": params.token,
      [DAEMON_EVENT_CAPABILITIES_HEADER]: DAEMON_CAPABILITY_EVENT_ENVELOPE_V2,
    },
    body: JSON.stringify(params.body),
  });
  const response = await handler(request);
  return { status: response.status, ok: response.status < 400 };
}

const HALT_POLL_EVERY_CHUNKS = 6;

async function streamDeltas(params: {
  state: EmulatorRunState;
  token: string;
  userId: string;
  messageId: string;
  kind: "text" | "thinking" | "tool-output";
  text: string;
  toolCallId?: string;
  deltaMs: number;
  chunkChars: number;
}): Promise<{ halted: boolean }> {
  const chunks = chunkText(params.text, params.chunkChars);
  for (let index = 0; index < chunks.length; index += 1) {
    if (index % HALT_POLL_EVERY_CHUNKS === 0) {
      const haltStatus = await getRunHaltStatus({
        runId: params.state.runId,
        userId: params.userId,
      });
      if (haltStatus !== "live") {
        return { halted: true };
      }
    }
    const body = buildDeltaBatch(params.state, [
      {
        messageId: params.messageId,
        partIndex: 0,
        kind: params.kind,
        text: chunks[index]!,
        ...(params.toolCallId !== undefined
          ? { toolCallId: params.toolCallId, stream: "stdout" as const }
          : {}),
      },
    ]);
    const result = await postBatch({ body, token: params.token });
    if (!result.ok) {
      console.warn("[agent-emulator] delta batch rejected, halting stream", {
        runId: params.state.runId,
        status: result.status,
      });
      return { halted: true };
    }
    await sleep(params.deltaMs);
  }
  return { halted: false };
}

async function postMessages(params: {
  state: EmulatorRunState;
  token: string;
  messages: ClaudeMessage[];
}): Promise<{ ok: boolean; status: number }> {
  const body = buildMessagesBatch(params.state, params.messages);
  return postBatch({ body, token: params.token });
}

export type RunEmulatorStreamParams = {
  userId: string;
  threadId: string;
  threadChatId: string;
  runId: string;
  token: string;
  prompt: string;
  scenario: EmulatorScenario;
  timezone: string;
};

export async function runEmulatorStream(
  params: RunEmulatorStreamParams,
): Promise<void> {
  const pacing = resolveEmulatorPacing();
  const state = createEmulatorRunState({
    runId: params.runId,
    threadId: params.threadId,
    threadChatId: params.threadChatId,
    timezone: params.timezone,
  });
  const steps = applyRunScopedStepIds(
    params.scenario.build(params.prompt),
    params.runId,
  );

  const finalizeStop = async (): Promise<void> => {
    const result = await postMessages({
      state,
      token: params.token,
      messages: terminalMessages({ kind: "stopped" }),
    });
    if (!result.ok) {
      console.warn("[agent-emulator] stopped reconcile terminal rejected", {
        runId: params.runId,
        status: result.status,
      });
    }
  };

  try {
    for (const step of steps) {
      const haltStatus = await getRunHaltStatus({
        runId: params.runId,
        userId: params.userId,
      });
      if (haltStatus === "stopped") {
        await finalizeStop();
        return;
      }
      if (haltStatus !== "live") {
        return;
      }
      const halted = await runStep({ state, step, params, pacing });
      if (halted) {
        const afterHalt = await getRunHaltStatus({
          runId: params.runId,
          userId: params.userId,
        });
        if (afterHalt === "stopped") {
          await finalizeStop();
        }
        return;
      }
      if (step.type !== "terminal") {
        await sleep(pacing.stepMs);
      }
    }
  } catch (error) {
    console.error("[agent-emulator] run stream failed", {
      runId: params.runId,
      threadId: params.threadId,
      threadChatId: params.threadChatId,
      error,
    });
  }
}

async function runStep(args: {
  state: EmulatorRunState;
  step: EmulatorStep;
  params: RunEmulatorStreamParams;
  pacing: ReturnType<typeof resolveEmulatorPacing>;
}): Promise<boolean> {
  const { state, step, params, pacing } = args;
  switch (step.type) {
    case "system-init": {
      const result = await postMessages({
        state,
        token: params.token,
        messages: [systemInitMessage()],
      });
      return !result.ok;
    }
    case "thinking":
    case "text": {
      const { halted } = await streamDeltas({
        state,
        token: params.token,
        userId: params.userId,
        messageId: step.messageId,
        kind: step.type === "thinking" ? "thinking" : "text",
        text: step.text,
        deltaMs: pacing.deltaMs,
        chunkChars: pacing.chunkChars,
      });
      return halted;
    }
    case "tool-call": {
      const start = await postMessages({
        state,
        token: params.token,
        messages: [
          toolCallStartMessage({
            toolCallId: step.toolCallId,
            name: step.name,
            input: step.input,
          }),
        ],
      });
      if (!start.ok) {
        return true;
      }
      await sleep(pacing.stepMs);
      if (step.output) {
        const { halted } = await streamDeltas({
          state,
          token: params.token,
          userId: params.userId,
          messageId: step.toolCallId,
          kind: "tool-output",
          text: step.output,
          toolCallId: step.toolCallId,
          deltaMs: pacing.deltaMs,
          chunkChars: pacing.chunkChars,
        });
        if (halted) {
          return true;
        }
      }
      const done = await postMessages({
        state,
        token: params.token,
        messages: [
          toolCallResultMessage({
            toolCallId: step.toolCallId,
            result: step.result,
            isError: step.isError ?? false,
          }),
        ],
      });
      return !done.ok;
    }
    case "terminal": {
      await postMessages({
        state,
        token: params.token,
        messages: terminalMessages(step.terminal),
      });
      return true;
    }
  }
}
