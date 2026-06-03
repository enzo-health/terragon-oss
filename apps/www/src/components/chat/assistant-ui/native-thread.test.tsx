/* @vitest-environment jsdom */

import {
  AssistantRuntimeProvider,
  useThreadRuntime,
  useExternalStoreRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { HttpAgent } from "@ag-ui/client";
import type { ThreadHistoryAdapter } from "@assistant-ui/react";
import {
  useAgUiRuntime,
  type UseAgUiRuntimeOptions,
} from "@assistant-ui/react-ag-ui";
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { NativeThread } from "./native-thread";
import {
  decodeToolGroupFlags,
  getToolGroupFlags,
  toolArgPreview,
  toolArgsDisplayText,
} from "./native-thread-utils";

beforeAll(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  if (!("ResizeObserver" in globalThis)) {
    (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
});

const SEED_MESSAGES: ThreadMessageLike[] = [
  { role: "user", content: "show me the files" },
  {
    role: "assistant",
    content: [
      { type: "reasoning", text: "I should list the directory" },
      { type: "text", text: "Here are the files." },
      {
        type: "tool-call",
        toolCallId: "t1",
        toolName: "Bash",
        argsText: '{"command":"ls"}',
        result: "file.txt",
      },
      // A rich Terragon data part: pure-native NativeThread renders nothing
      // for it (the bespoke renderers are removed) and must not crash.
      {
        type: "data",
        name: "terragon.terminal",
        data: { type: "terminal", terminalId: "term-1" },
      },
    ],
  },
];

function Harness({
  messages = SEED_MESSAGES,
}: {
  messages?: ThreadMessageLike[];
}) {
  const runtime = useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    isRunning: false,
    convertMessage: (message) => message,
    onNew: async () => {},
  });
  return createElement(
    AssistantRuntimeProvider,
    { runtime },
    createElement(NativeThread),
  );
}

class ImmediateFinishAgent extends HttpAgent {
  public runCount = 0;

  public override async runAgent(
    _parameters?: Parameters<HttpAgent["runAgent"]>[0],
    _subscriber?: Parameters<HttpAgent["runAgent"]>[1],
  ): Promise<Awaited<ReturnType<HttpAgent["runAgent"]>>> {
    this.runCount += 1;
    return { result: null, newMessages: [] };
  }
}

function RuntimeAppendButton() {
  const runtime = useThreadRuntime();
  return createElement(
    "button",
    {
      type: "button",
      onClick: () =>
        runtime.append({
          role: "user",
          content: [
            {
              type: "text",
              text: "Submitted follow-up appears from assistant-ui runtime",
            },
          ],
        }),
    },
    "send",
  );
}

function AgUiRuntimeHarness({ agent }: { agent: HttpAgent }) {
  const runtime = useAgUiRuntime({ agent });
  return createElement(
    AssistantRuntimeProvider,
    { runtime },
    createElement(RuntimeAppendButton),
    createElement(NativeThread),
  );
}

function AgUiMergeRuntimeHarness({
  agent,
  history,
}: {
  agent: HttpAgent;
  history: ThreadHistoryAdapter;
}) {
  const [options, setOptions] = useState<UseAgUiRuntimeOptions>({
    agent,
    externalMessagesStrategy: "merge-after-local-mutations",
    adapters: { history },
  });
  const runtime = useAgUiRuntime(options);
  return createElement(
    AssistantRuntimeProvider,
    { runtime },
    createElement(RuntimeAppendButton),
    createElement(
      "button",
      {
        type: "button",
        onClick: () =>
          setOptions({
            agent,
            externalMessagesStrategy: "merge-after-local-mutations",
            adapters: {
              history: {
                ...history,
                load: history.load,
              },
            },
          }),
      },
      "stale-history",
    ),
    createElement(NativeThread),
  );
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  container = null;
  root = null;
});

describe("NativeThread", () => {
  it("computes grouped tool-call summary in one part-range pass", () => {
    const parts = [
      { type: "text" },
      {
        type: "tool-call",
        status: { type: "complete" },
        result: "ok",
      },
      {
        type: "tool-call",
        status: { type: "running" },
      },
      {
        type: "tool-call",
        status: { type: "incomplete" },
        result: "bad",
        isError: true,
      },
    ];

    const state = decodeToolGroupFlags(getToolGroupFlags(parts, 1, 3));

    expect(state).toEqual({
      count: 3,
      hasActive: true,
      hasError: true,
    });
  });

  it("renders text, reasoning, and tool calls through native assistant-ui primitives", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(createElement(Harness));
    });
    const text = container?.textContent ?? "";

    expect(text).toContain("show me the files");
    expect(text).toContain("Here are the files.");
    expect(text).toContain("Thinking");
    expect(text).toContain("I should list the directory");
    expect(text).toContain("Bash");
    expect(text).toContain("file.txt");
    expect(text).not.toContain("term-1");
    expect(text).not.toContain("terragon.terminal");
  });

  it("renders terragon.error data parts through the NativeError callout", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(
        createElement(Harness, {
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "data",
                  name: "terragon.error",
                  data: { message: "Sandbox failed to start" },
                },
                // Fallback shape: no `message`, only `value`.
                {
                  type: "data",
                  name: "terragon.error",
                  data: { value: "Run aborted before completion" },
                },
              ],
            },
          ],
        }),
      );
    });

    const alerts = container?.querySelectorAll("[role=alert]") ?? [];
    expect(alerts.length).toBe(2);
    const text = container?.textContent ?? "";
    expect(text).toContain("Sandbox failed to start");
    expect(text).toContain("Run aborted before completion");
  });

  it("applies paint containment to native message roots", () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(createElement(Harness));
    });

    const userBubble = Array.from(
      container.querySelectorAll(
        "[data-slot=message-text][data-variant=bubble]",
      ),
    ).find((element) => element.textContent?.includes("show me the files"));
    const userRoot = userBubble?.closest(
      "[class*='content-visibility']",
    ) as HTMLElement | null;
    const assistantContent = Array.from(
      container.querySelectorAll("[data-slot=message-content]"),
    ).find((element) => element.textContent?.includes("Here are the files."));
    const assistantRoot = assistantContent?.closest(
      "[class*='content-visibility']",
    ) as HTMLElement | null;

    expect(userRoot?.className).toContain("[content-visibility:auto]");
    expect(userRoot?.className).toContain("[contain-intrinsic-size:auto_96px]");
    expect(assistantRoot?.className).toContain("[content-visibility:auto]");
    expect(assistantRoot?.className).toContain(
      "[contain-intrinsic-size:auto_160px]",
    );
  });

  it("collapses consecutive completed tool calls into a native assistant-ui group", async () => {
    const messages: ThreadMessageLike[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Checking context." },
          {
            type: "tool-call",
            toolCallId: "t1",
            toolName: "Read",
            argsText: '{"file_path":"src/a.ts"}',
            result: "a",
          },
          {
            type: "tool-call",
            toolCallId: "t2",
            toolName: "Grep",
            argsText: '{"pattern":"NativeToolCall"}',
            result: "b",
          },
        ],
      },
    ];

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(createElement(Harness, { messages }));
    });

    const toolGroup = Array.from(
      container.querySelectorAll("[data-slot=tool]"),
    ).find((tool) =>
      tool
        .querySelector("[data-slot=tool-name]")
        ?.textContent?.includes("Tool calls (2)"),
    );
    if (!toolGroup) {
      throw new Error("expected grouped tool-call disclosure");
    }

    expect(toolGroup.hasAttribute("data-open")).toBe(false);

    const trigger = toolGroup.querySelector("[data-slot=tool-trigger]");
    if (!trigger) {
      throw new Error("expected grouped tool-call trigger");
    }

    await act(async () => {
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(toolGroup.hasAttribute("data-open")).toBe(true);
  });

  it("keeps historical failed tool groups collapsed by default", async () => {
    const messages: ThreadMessageLike[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Checking context." },
          {
            type: "tool-call",
            toolCallId: "t1",
            toolName: "Bash",
            argsText: '{"command":"rg scheduling"}',
            result: "rg: not found",
            isError: true,
          },
          {
            type: "tool-call",
            toolCallId: "t2",
            toolName: "Read",
            argsText: '{"file_path":"docs/scheduling/README.md"}',
            result: "docs",
          },
        ],
      },
    ];

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(createElement(Harness, { messages }));
    });

    const toolGroup = Array.from(
      container.querySelectorAll("[data-slot=tool]"),
    ).find((tool) =>
      tool
        .querySelector("[data-slot=tool-name]")
        ?.textContent?.includes("Tool calls (2)"),
    );
    if (!toolGroup) {
      throw new Error("expected grouped tool-call disclosure");
    }

    expect(toolGroup.textContent).toContain("Needs attention");
    expect(toolGroup.getAttribute("data-state")).toBe("error");
    expect(toolGroup.hasAttribute("data-open")).toBe(false);
  });

  it("keeps a single historical failed tool call collapsed by default", async () => {
    const messages: ThreadMessageLike[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "t1",
            toolName: "Bash",
            argsText: '{"command":"rg scheduling"}',
            result: "rg: not found",
            isError: true,
          },
        ],
      },
    ];

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(createElement(Harness, { messages }));
    });

    const toolCall = Array.from(
      container.querySelectorAll("[data-slot=tool]"),
    ).find((tool) =>
      tool
        .querySelector("[data-slot=tool-name]")
        ?.textContent?.includes("Bash"),
    );
    if (!toolCall) {
      throw new Error("expected tool-call disclosure");
    }

    expect(toolCall.getAttribute("data-state")).toBe("error");
    expect(toolCall.hasAttribute("data-open")).toBe(false);
  });

  it("extracts streamed tool arg previews without requiring valid JSON", () => {
    const longCommand = "pnpm ".repeat(1200);
    const preview = toolArgPreview(`{"command":"${longCommand}`);

    expect(preview).toBe(longCommand.slice(0, preview?.length));
    expect(preview?.length).toBeLessThan(longCommand.length);
  });

  it("bounds rendered args for active tool calls", () => {
    const longArgs = `{"command":"${"pnpm test ".repeat(500)}"}`;

    expect(toolArgsDisplayText(longArgs, true)).toHaveLength(2000);
    expect(toolArgsDisplayText(longArgs, true)).toMatch(/…$/);
    expect(toolArgsDisplayText(longArgs, false)).toBe(longArgs);
  });

  it("shows submitted follow-up text through the AG-UI assistant runtime", async () => {
    const agent = new ImmediateFinishAgent({
      url: "/api/ag-ui/thread-1?threadChatId=chat-1",
      threadId: "thread-1",
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(createElement(AgUiRuntimeHarness, { agent }));
    });

    const sendButton = container.querySelector("button");
    if (!sendButton) {
      throw new Error("expected send button");
    }

    await act(async () => {
      sendButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(container.textContent).toContain(
      "Submitted follow-up appears from assistant-ui runtime",
    );
    expect(agent.runCount).toBe(1);
  });

  it("keeps locally submitted text when stale external history re-applies", async () => {
    const agent = new ImmediateFinishAgent({
      url: "/api/ag-ui/thread-1?threadChatId=chat-1",
      threadId: "thread-1",
    });
    const history: ThreadHistoryAdapter = {
      load: async () => ({
        headId: null,
        messages: [],
        unstable_resume: false,
      }),
      append: async () => {},
    };

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(createElement(AgUiMergeRuntimeHarness, { agent, history }));
    });

    const buttons = Array.from(container.querySelectorAll("button"));
    const sendButton = buttons.find((button) => button.textContent === "send");
    const staleHistoryButton = buttons.find(
      (button) => button.textContent === "stale-history",
    );
    if (!sendButton || !staleHistoryButton) {
      throw new Error("expected runtime test buttons");
    }

    await act(async () => {
      sendButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.textContent).toContain(
      "Submitted follow-up appears from assistant-ui runtime",
    );

    await act(async () => {
      staleHistoryButton.dispatchEvent(
        new MouseEvent("click", { bubbles: true }),
      );
    });

    expect(container.textContent).toContain(
      "Submitted follow-up appears from assistant-ui runtime",
    );
  });
});
