/* @vitest-environment jsdom */

import type { AIModel } from "@terragon/agent/types";
import type { DBUserMessage } from "@terragon/shared";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComposerValue } from "@/components/ai/composer-rich";
import type { Typeahead } from "./typeahead/typeahead";
import { type HandleSubmit, usePromptBox } from "./use-promptbox";

const selectedModel = "claude-3-5-sonnet-20241022" as AIModel;
const nonEmptyValue: ComposerValue = {
  text: "approve it",
  segments: [{ type: "text", value: "approve it" }],
};

vi.mock("@/hooks/useTouchDevice", () => ({
  useTouchDevice: () => false,
}));

vi.mock("@/hooks/use-selected-model", () => ({
  useSelectedModel: () => ({
    selectedModel: "claude-3-5-sonnet-20241022",
    selectedModels: {},
    setSelectedModel: vi.fn(),
    isMultiAgentMode: false,
    setIsMultiAgentMode: vi.fn(),
  }),
}));

type PromptBoxController = {
  submitForm: (args: {
    saveAsDraft: boolean;
    scheduleAt: number | null;
  }) => void;
  setPermissionMode: (mode: "allowAll" | "plan") => void;
  setValue: (value: ComposerValue) => void;
};

const typeahead: Typeahead = {
  getSuggestions: async () => [],
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let controller: PromptBoxController | null = null;

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount();
    });
    root = null;
  }
  container?.remove();
  container = null;
  controller = null;
  vi.clearAllMocks();
});

type HarnessProps = {
  handleSubmit: HandleSubmit;
  handleQueueMessage?: HandleSubmit;
  permissionMode?: "allowAll" | "plan";
  isAgentWorking?: boolean;
  isQueueingEnabled?: boolean;
};

function Harness(props: HarnessProps): null {
  const promptBox = usePromptBox({
    threadId: "thread-1",
    placeholderText: "Message",
    repoFullName: "terragon/oss",
    branchName: "main",
    forcedAgent: "claudeCode",
    forcedAgentVersion: 1,
    initialSelectedModel: selectedModel,
    handleStop: async () => {},
    handleSubmit: props.handleSubmit,
    handleQueueMessage: props.handleQueueMessage,
    typeahead,
    clearContentOnSubmit: false,
    clearContentBeforeSubmit: false,
    initialPermissionMode: props.permissionMode ?? "allowAll",
    supportsMultiAgentPromptSubmission: false,
    disableLocalStorage: true,
    isAgentWorking: props.isAgentWorking ?? false,
    isQueueingEnabled: props.isQueueingEnabled ?? false,
  });
  controller = {
    submitForm: promptBox.submitForm,
    setPermissionMode: promptBox.setPermissionMode,
    setValue: promptBox.setValue,
  };
  return null;
}

async function mountHarness(props: HarnessProps): Promise<void> {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(createElement(Harness, props));
    await Promise.resolve();
  });
  await act(async () => {
    controller?.setValue(nonEmptyValue);
    await Promise.resolve();
  });
}

describe("usePromptBox submit routing", () => {
  it("submits an idle message through handleSubmit", async () => {
    const submittedMessages: DBUserMessage[] = [];
    const handleSubmit: HandleSubmit = async ({ userMessage }) => {
      submittedMessages.push(userMessage);
    };

    await mountHarness({ handleSubmit });
    await act(async () => {
      controller?.submitForm({ saveAsDraft: false, scheduleAt: null });
      await Promise.resolve();
    });

    expect(submittedMessages).toHaveLength(1);
    expect(submittedMessages[0]?.parts[0]).toMatchObject({ type: "rich-text" });
  });

  it("ignores a second submit while the first is still in flight", async () => {
    let resolveSubmit: (() => void) | null = null;
    const handleSubmit = vi.fn<HandleSubmit>(
      () =>
        new Promise<void>((resolve) => {
          resolveSubmit = resolve;
        }),
    );

    await mountHarness({ handleSubmit });
    await act(async () => {
      controller?.submitForm({ saveAsDraft: false, scheduleAt: null });
      controller?.submitForm({ saveAsDraft: false, scheduleAt: null });
      await Promise.resolve();
    });

    expect(handleSubmit).toHaveBeenCalledOnce();

    await act(async () => {
      resolveSubmit?.();
      await Promise.resolve();
    });
  });

  it("queues at the composer boundary when queueing is enabled and the agent is active", async () => {
    const submittedMessages: DBUserMessage[] = [];
    const queuedMessages: DBUserMessage[] = [];
    const handleSubmit: HandleSubmit = async ({ userMessage }) => {
      submittedMessages.push(userMessage);
    };
    const handleQueueMessage: HandleSubmit = async ({ userMessage }) => {
      queuedMessages.push(userMessage);
    };

    await mountHarness({
      handleSubmit,
      handleQueueMessage,
      isAgentWorking: true,
      isQueueingEnabled: true,
    });
    await act(async () => {
      controller?.submitForm({ saveAsDraft: false, scheduleAt: null });
      await Promise.resolve();
    });

    expect(submittedMessages).toHaveLength(0);
    expect(queuedMessages).toHaveLength(1);
  });
});

describe("usePromptBox permission mode", () => {
  it("uses local selection until the view-model prop changes, then uses the synced prop on submit", async () => {
    const submittedMessages: DBUserMessage[] = [];
    const handleSubmit: HandleSubmit = async ({ userMessage }) => {
      submittedMessages.push(userMessage);
    };

    await mountHarness({ handleSubmit, permissionMode: "plan" });

    await act(async () => {
      controller?.submitForm({ saveAsDraft: false, scheduleAt: null });
      await Promise.resolve();
    });
    expect(submittedMessages.at(-1)?.permissionMode).toBe("plan");

    await act(async () => {
      root?.render(
        createElement(Harness, { permissionMode: "allowAll", handleSubmit }),
      );
      await Promise.resolve();
    });
    await act(async () => {
      controller?.submitForm({ saveAsDraft: false, scheduleAt: null });
      await Promise.resolve();
    });

    expect(submittedMessages.at(-1)?.permissionMode).toBe("allowAll");

    await act(async () => {
      controller?.setPermissionMode("plan");
    });
    await act(async () => {
      root?.render(
        createElement(Harness, { permissionMode: "allowAll", handleSubmit }),
      );
      await Promise.resolve();
    });
    await act(async () => {
      controller?.submitForm({ saveAsDraft: false, scheduleAt: null });
      await Promise.resolve();
    });

    expect(submittedMessages.at(-1)?.permissionMode).toBe("plan");
  });
});
