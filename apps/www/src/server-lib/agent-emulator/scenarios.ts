import type { ClaudeMessage } from "@terragon/daemon/shared";
import { EMULATOR_SESSION_ID } from "./daemon-batches";

export type EmulatorTerminal =
  | { kind: "completed"; resultText: string }
  | { kind: "failed"; errorInfo: string }
  | { kind: "rate-limit"; resetTimeSec: number }
  | { kind: "oauth-revoked" }
  | { kind: "context-exhausted" }
  | { kind: "stopped" };

export type EmulatorStep =
  | { type: "system-init" }
  | { type: "thinking"; messageId: string; text: string }
  | { type: "text"; messageId: string; text: string }
  | {
      type: "tool-call";
      toolCallId: string;
      name: string;
      input: Record<string, unknown>;
      output?: string;
      result: string;
      isError?: boolean;
    }
  | { type: "terminal"; terminal: EmulatorTerminal };

export type EmulatorScenario = {
  name: string;
  description: string;
  build: (prompt: string) => EmulatorStep[];
};

const EMULATION_BANNER =
  "This is an emulated response from the Terragon dev agent emulator. No real model, sandbox, or repository was used.";

function clampPrompt(prompt: string): string {
  const trimmed = prompt.trim();
  if (trimmed.length === 0) {
    return "(empty prompt)";
  }
  return trimmed.length > 280 ? `${trimmed.slice(0, 277)}...` : trimmed;
}

function systemInit(): EmulatorStep {
  return { type: "system-init" };
}

export function terminalMessages(terminal: EmulatorTerminal): ClaudeMessage[] {
  switch (terminal.kind) {
    case "completed":
      return [
        {
          type: "result",
          subtype: "success",
          total_cost_usd: 0.0001,
          duration_ms: 1200,
          duration_api_ms: 1000,
          is_error: false,
          num_turns: 1,
          result: terminal.resultText,
          session_id: EMULATOR_SESSION_ID,
        },
      ];
    case "failed":
      return [
        {
          type: "custom-error",
          session_id: null,
          duration_ms: 1000,
          error_info: terminal.errorInfo,
        },
      ];
    case "rate-limit":
      return [
        {
          type: "result",
          subtype: "success",
          result: `Claude AI usage limit reached|${terminal.resetTimeSec}`,
          total_cost_usd: 0.0001,
          duration_ms: 1000,
          duration_api_ms: 1000,
          is_error: false,
          num_turns: 1,
          session_id: EMULATOR_SESSION_ID,
        },
        { type: "custom-error", session_id: null, duration_ms: 1000 },
      ];
    case "oauth-revoked":
      return [
        {
          type: "result",
          subtype: "success",
          total_cost_usd: 0,
          duration_ms: 1000,
          duration_api_ms: 1000,
          is_error: true,
          num_turns: 1,
          result: "OAuth token revoked",
          session_id: EMULATOR_SESSION_ID,
        },
      ];
    case "context-exhausted":
      return [
        {
          type: "result",
          subtype: "success",
          total_cost_usd: 0,
          duration_ms: 1000,
          duration_api_ms: 1000,
          is_error: true,
          num_turns: 1,
          result: "Prompt is too long",
          session_id: EMULATOR_SESSION_ID,
        },
      ];
    case "stopped":
      return [{ type: "custom-stop", session_id: null, duration_ms: 1000 }];
  }
}

const defaultScenario: EmulatorScenario = {
  name: "default",
  description:
    "Greeting, reasoning, a streamed bash tool call, a file edit, and a clean completion.",
  build: (prompt) => {
    const echoed = clampPrompt(prompt);
    return [
      systemInit(),
      {
        type: "thinking",
        messageId: "emulator-thinking-1",
        text: `The user said: "${echoed}". Let me put together a short emulated walkthrough that exercises text, a tool call, and a file edit.`,
      },
      {
        type: "text",
        messageId: "emulator-text-1",
        text: `You asked: "${echoed}".\n\n${EMULATION_BANNER}\n\nHere is what an emulated turn looks like end to end.`,
      },
      {
        type: "tool-call",
        toolCallId: "emulator-bash-1",
        name: "Bash",
        input: { command: `echo "${echoed}" && ls -1` },
        output: `${echoed}\nREADME.md\npackage.json\nsrc\n`,
        result: `${echoed}\nREADME.md\npackage.json\nsrc\n`,
      },
      {
        type: "tool-call",
        toolCallId: "emulator-edit-1",
        name: "Edit",
        input: {
          file_path: "/workspace/emulated-notes.md",
          old_string: "placeholder",
          new_string: `emulated response for: ${echoed}`,
        },
        result: "The file /workspace/emulated-notes.md has been updated.",
      },
      {
        type: "text",
        messageId: "emulator-text-2",
        text: "Done. That wraps up the emulated turn — text, tools, and a completion, all without a real backend.",
      },
      {
        type: "terminal",
        terminal: {
          kind: "completed",
          resultText: "Emulated run complete.",
        },
      },
    ];
  },
};

const longStreamScenario: EmulatorScenario = {
  name: "long-stream",
  description:
    "Several markdown paragraphs including a code block, steady delta pacing — for streaming feel testing.",
  build: (prompt) => {
    const echoed = clampPrompt(prompt);
    const body = [
      `## Emulated long-form response`,
      ``,
      `${EMULATION_BANNER}`,
      ``,
      `You asked: "${echoed}". Below is a longer stream so you can feel token-by-token rendering, markdown formatting, and code blocks without any real model in the loop.`,
      ``,
      `### How the emulator works`,
      ``,
      `1. The dispatch flow detects the emulator env flag and skips sandbox boot and git.`,
      `2. A run context is created and a real daemon token is minted.`,
      `3. Scripted batches are POSTed to \`/api/daemon-event\` exactly like a real daemon — envelope v2, canonical events, and streaming deltas.`,
      ``,
      `### A little code`,
      ``,
      "```ts",
      `async function emulate(prompt: string) {`,
      `  const state = createEmulatorRunState({ runId, threadId, threadChatId, timezone });`,
      `  for (const step of scenario.build(prompt)) {`,
      `    await postBatchesForStep(state, step);`,
      `  }`,
      `}`,
      "```",
      ``,
      `### Wrapping up`,
      ``,
      `Everything you see rendered here arrived through the real ingest pipeline: auth, fence, project, persist, and publish. The only difference from production is that the content is scripted rather than generated.`,
    ].join("\n");
    return [
      systemInit(),
      { type: "text", messageId: "emulator-long-1", text: body },
      {
        type: "terminal",
        terminal: {
          kind: "completed",
          resultText: "Emulated long stream complete.",
        },
      },
    ];
  },
};

function recoverableScenario(params: {
  name: string;
  description: string;
  terminal: (prompt: string) => EmulatorTerminal;
  note: string;
}): EmulatorScenario {
  return {
    name: params.name,
    description: params.description,
    build: (prompt) => {
      const echoed = clampPrompt(prompt);
      return [
        systemInit(),
        {
          type: "text",
          messageId: `emulator-${params.name}-1`,
          text: `You asked: "${echoed}".\n\n${EMULATION_BANNER}\n\n${params.note}`,
        },
        { type: "terminal", terminal: params.terminal(prompt) },
      ];
    },
  };
}

const rateLimitScenario = recoverableScenario({
  name: "rate-limit",
  description:
    "Ends on a recoverable rate-limit terminal (retryAfterMs ~1 hour) that queues for reattempt.",
  note: "This turn ends on a simulated Claude usage-limit terminal, which the ingest pipeline treats as a recoverable rate-limit.",
  terminal: () => ({
    kind: "rate-limit",
    resetTimeSec: Math.floor((Date.now() + 60 * 60 * 1000) / 1000),
  }),
});

const oauthRevokedScenario = recoverableScenario({
  name: "oauth-revoked",
  description: "Ends on a recoverable oauth-token-revoked terminal.",
  note: "This turn ends on a simulated OAuth-token-revoked terminal to exercise the typed recovery path.",
  terminal: () => ({ kind: "oauth-revoked" }),
});

const contextExhaustedScenario = recoverableScenario({
  name: "context-exhausted",
  description: "Ends on a recoverable context-exhausted terminal.",
  note: "This turn ends on a simulated context-window-exhausted terminal to exercise the Wave 2/4 typed recovery path.",
  terminal: () => ({ kind: "context-exhausted" }),
});

const errorScenario = recoverableScenario({
  name: "error",
  description: "Ends on a non-recoverable failed terminal.",
  note: "This turn ends on a simulated unrecoverable failure.",
  terminal: () => ({ kind: "failed", errorInfo: "Emulated agent failure" }),
});

const stoppedScenario: EmulatorScenario = {
  name: "stopped",
  description:
    "Streams slowly so you can click Stop mid-run; self-terminates with a stopped terminal if you do not.",
  build: (prompt) => {
    const echoed = clampPrompt(prompt);
    return [
      systemInit(),
      {
        type: "thinking",
        messageId: "emulator-stop-thinking-1",
        text: "Taking my time here so there is a window to press Stop before the turn finishes.",
      },
      {
        type: "text",
        messageId: "emulator-stop-1",
        text: `You asked: "${echoed}".\n\n${EMULATION_BANNER}\n\nThis stream is intentionally slow. Press Stop now to interrupt it, or wait for the emulated stop.`,
      },
      {
        type: "text",
        messageId: "emulator-stop-2",
        text: "Still streaming... still streaming... still streaming... any moment now the emulator will stop on its own if you have not already.",
      },
      { type: "terminal", terminal: { kind: "stopped" } },
    ];
  },
};

const SCENARIOS: EmulatorScenario[] = [
  defaultScenario,
  longStreamScenario,
  rateLimitScenario,
  oauthRevokedScenario,
  contextExhaustedScenario,
  errorScenario,
  stoppedScenario,
];

export const EMULATOR_SCENARIOS: ReadonlyMap<string, EmulatorScenario> =
  new Map(SCENARIOS.map((scenario) => [scenario.name, scenario]));

export const DEFAULT_EMULATOR_SCENARIO = defaultScenario;

export type ResolvedEmulatorScenario = {
  scenario: EmulatorScenario;
  prompt: string;
};

export function resolveEmulatorScenario(
  rawPrompt: string,
): ResolvedEmulatorScenario {
  const match = rawPrompt.match(
    /^\s*\/emulate(?:\s+([a-z0-9-]+))?\b([\s\S]*)$/i,
  );
  if (!match) {
    return { scenario: DEFAULT_EMULATOR_SCENARIO, prompt: rawPrompt };
  }
  const requestedName = match[1]?.toLowerCase();
  const remainder = match[2]?.trim() ?? "";
  const scenario =
    (requestedName && EMULATOR_SCENARIOS.get(requestedName)) ||
    DEFAULT_EMULATOR_SCENARIO;
  const prompt = remainder.length > 0 ? remainder : rawPrompt.trim();
  return { scenario, prompt };
}
