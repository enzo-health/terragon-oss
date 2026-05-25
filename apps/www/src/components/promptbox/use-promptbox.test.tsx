/* @vitest-environment jsdom */

import type { AIModel } from "@terragon/agent/types";
import type { DBUserMessage } from "@terragon/shared";
import type { JSONContent } from "@tiptap/react";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Typeahead } from "./typeahead/typeahead";
import { type HandleSubmit, usePromptBox } from "./use-promptbox";

const selectedModel = "claude-3-5-sonnet-20241022" as AIModel;
const editorJson: JSONContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "approve it" }],
    },
  ],
};

const mocks = vi.hoisted(() => ({
  clearContent: vi.fn(),
  dispatch: vi.fn(),
  appendFn: vi.fn(),
  useThreadRuntimeReturn: null as { append: ReturnType<typeof vi.fn> } | null,
}));

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

vi.mock("@assistant-ui/react", () => ({
  useThreadRuntime: () => mocks.useThreadRuntimeReturn,
}));

vi.mock("@tiptap/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tiptap/react")>();
  return {
    ...actual,
    useEditor: () => ({
      getText: () => "approve it",
      getJSON: () => editorJson,
      getHTML: () => "<p>approve it</p>",
      isEmpty: false,
      commands: {
        clearContent: mocks.clearContent,
        focus: vi.fn(),
      },
      extensionManager: { extensions: [] },
      view: { dispatch: mocks.dispatch },
      state: { tr: {} },
    }),
  };
});

type PromptBoxController = {
  submitForm: (args: {
    saveAsDraft: boolean;
    scheduleAt: number | null;
  }) => void;
  setPermissionMode: (mode: "allowAll" | "plan") => void;
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
  mocks.useThreadRuntimeReturn = null;
  vi.clearAllMocks();
});

function Harness({
  permissionMode,
  onSubmit,
}: {
  permissionMode: "allowAll" | "plan";
  onSubmit: HandleSubmit;
}): null {
  const promptBox = usePromptBox({
    threadId: "thread-1",
    placeholderText: "Message",
    repoFullName: "terragon/oss",
    branchName: "main",
    forcedAgent: "claudeCode",
    forcedAgentVersion: 1,
    initialSelectedModel: selectedModel,
    handleStop: async () => {},
    handleSubmit: onSubmit,
    typeahead,
    clearContentOnSubmit: false,
    clearContentBeforeSubmit: false,
    initialPermissionMode: permissionMode,
    supportsMultiAgentPromptSubmission: false,
    disableLocalStorage: true,
  });
  controller = {
    submitForm: promptBox.submitForm,
    setPermissionMode: promptBox.setPermissionMode,
  };
  return null;
}

describe("usePromptBox runtime routing", () => {
  it("calls runtime.append when a thread runtime is in context", async () => {
    mocks.appendFn.mockReset();
    mocks.useThreadRuntimeReturn = { append: mocks.appendFn };

    const submittedMessages: DBUserMessage[] = [];
    const handleSubmit: HandleSubmit = async ({ userMessage }) => {
      submittedMessages.push(userMessage);
    };

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    let capturedController: PromptBoxController | null = null;
    function RuntimePresentHarness(): null {
      const promptBox = usePromptBox({
        threadId: "thread-1",
        placeholderText: "Message",
        repoFullName: "terragon/oss",
        branchName: "main",
        forcedAgent: "claudeCode",
        forcedAgentVersion: 1,
        initialSelectedModel: selectedModel,
        handleStop: async () => {},
        handleSubmit,
        typeahead,
        clearContentOnSubmit: false,
        clearContentBeforeSubmit: false,
        initialPermissionMode: "allowAll",
        supportsMultiAgentPromptSubmission: false,
        disableLocalStorage: true,
      });
      capturedController = {
        submitForm: promptBox.submitForm,
        setPermissionMode: promptBox.setPermissionMode,
      };
      return null;
    }

    await act(async () => {
      root.render(createElement(RuntimePresentHarness));
    });
    await act(async () => {
      capturedController?.submitForm({ saveAsDraft: false, scheduleAt: null });
      await Promise.resolve();
    });

    expect(submittedMessages).toHaveLength(0);
    expect(mocks.appendFn).toHaveBeenCalledOnce();
    const appendArg = mocks.appendFn.mock.calls[0]?.[0] as {
      role: string;
      content: Array<{ type: string; text?: string }>;
    };
    expect(appendArg.role).toBe("user");
    expect(appendArg.content).toHaveLength(1);
    expect(appendArg.content[0]?.type).toBe("text");
    expect(appendArg.content[0]?.text).toBe("approve it");

    act(() => {
      root.unmount();
    });
    container.remove();
    mocks.useThreadRuntimeReturn = null;
  });

  it("ignores a second submit while the first submit is still in flight", async () => {
    mocks.appendFn.mockReset();
    mocks.useThreadRuntimeReturn = null;

    let resolveSubmit: (() => void) | null = null;
    const handleSubmit = vi.fn<HandleSubmit>(
      () =>
        new Promise<void>((resolve) => {
          resolveSubmit = resolve;
        }),
    );

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    let capturedController: PromptBoxController | null = null;
    function InFlightHarness(): null {
      const promptBox = usePromptBox({
        threadId: "thread-1",
        placeholderText: "Message",
        repoFullName: "terragon/oss",
        branchName: "main",
        forcedAgent: "claudeCode",
        forcedAgentVersion: 1,
        initialSelectedModel: selectedModel,
        handleStop: async () => {},
        handleSubmit,
        typeahead,
        clearContentOnSubmit: false,
        clearContentBeforeSubmit: false,
        initialPermissionMode: "allowAll",
        supportsMultiAgentPromptSubmission: false,
        disableLocalStorage: true,
      });
      capturedController = {
        submitForm: promptBox.submitForm,
        setPermissionMode: promptBox.setPermissionMode,
      };
      return null;
    }

    await act(async () => {
      root.render(createElement(InFlightHarness));
    });
    await act(async () => {
      capturedController?.submitForm({ saveAsDraft: false, scheduleAt: null });
      capturedController?.submitForm({ saveAsDraft: false, scheduleAt: null });
      await Promise.resolve();
    });

    expect(handleSubmit).toHaveBeenCalledOnce();

    await act(async () => {
      resolveSubmit?.();
      await Promise.resolve();
    });

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("keeps the submit lock while runtime append is still in flight", async () => {
    mocks.appendFn.mockReset();
    let resolveAppend: (() => void) | null = null;
    mocks.appendFn.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveAppend = resolve;
        }),
    );
    mocks.useThreadRuntimeReturn = { append: mocks.appendFn };

    const handleSubmit = vi.fn<HandleSubmit>(async () => {});

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    let capturedController: PromptBoxController | null = null;
    function RuntimeInFlightHarness(): null {
      const promptBox = usePromptBox({
        threadId: "thread-1",
        placeholderText: "Message",
        repoFullName: "terragon/oss",
        branchName: "main",
        forcedAgent: "claudeCode",
        forcedAgentVersion: 1,
        initialSelectedModel: selectedModel,
        handleStop: async () => {},
        handleSubmit,
        typeahead,
        clearContentOnSubmit: false,
        clearContentBeforeSubmit: false,
        initialPermissionMode: "allowAll",
        supportsMultiAgentPromptSubmission: false,
        disableLocalStorage: true,
      });
      capturedController = {
        submitForm: promptBox.submitForm,
        setPermissionMode: promptBox.setPermissionMode,
      };
      return null;
    }

    await act(async () => {
      root.render(createElement(RuntimeInFlightHarness));
    });

    await act(async () => {
      void capturedController?.submitForm({
        saveAsDraft: false,
        scheduleAt: null,
      });
      void capturedController?.submitForm({
        saveAsDraft: false,
        scheduleAt: null,
      });
      await Promise.resolve();
    });

    expect(mocks.appendFn).toHaveBeenCalledOnce();

    await act(async () => {
      resolveAppend?.();
      await Promise.resolve();
    });

    act(() => {
      root.unmount();
    });
    container.remove();
    mocks.useThreadRuntimeReturn = null;
  });

  it("falls back to handleSubmit when no runtime is in context (dashboard / generic composer)", async () => {
    mocks.appendFn.mockReset();
    mocks.useThreadRuntimeReturn = null;

    const submittedMessages: DBUserMessage[] = [];
    const handleSubmit: HandleSubmit = async ({ userMessage }) => {
      submittedMessages.push(userMessage);
    };

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    let capturedController: PromptBoxController | null = null;
    function NoRuntimeHarness(): null {
      const promptBox = usePromptBox({
        threadId: "thread-1",
        placeholderText: "Message",
        repoFullName: "terragon/oss",
        branchName: "main",
        forcedAgent: "claudeCode",
        forcedAgentVersion: 1,
        initialSelectedModel: selectedModel,
        handleStop: async () => {},
        handleSubmit,
        typeahead,
        clearContentOnSubmit: false,
        clearContentBeforeSubmit: false,
        initialPermissionMode: "allowAll",
        supportsMultiAgentPromptSubmission: false,
        disableLocalStorage: true,
      });
      capturedController = {
        submitForm: promptBox.submitForm,
        setPermissionMode: promptBox.setPermissionMode,
      };
      return null;
    }

    await act(async () => {
      root.render(createElement(NoRuntimeHarness));
    });
    await act(async () => {
      capturedController?.submitForm({ saveAsDraft: false, scheduleAt: null });
      await Promise.resolve();
    });

    expect(submittedMessages).toHaveLength(1);
    expect(mocks.appendFn).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
    container.remove();
    mocks.useThreadRuntimeReturn = null;
  });

  it("queues at the composer boundary when queueing is enabled and the agent is active", async () => {
    mocks.appendFn.mockReset();
    mocks.useThreadRuntimeReturn = { append: mocks.appendFn };

    const submittedMessages: DBUserMessage[] = [];
    const queuedMessages: DBUserMessage[] = [];
    const handleSubmit: HandleSubmit = async ({ userMessage }) => {
      submittedMessages.push(userMessage);
    };
    const handleQueueMessage: HandleSubmit = async ({ userMessage }) => {
      queuedMessages.push(userMessage);
    };

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    let capturedController: PromptBoxController | null = null;
    function ActiveRuntimeHarness(): null {
      const promptBox = usePromptBox({
        threadId: "thread-1",
        placeholderText: "Message",
        repoFullName: "terragon/oss",
        branchName: "main",
        forcedAgent: "claudeCode",
        forcedAgentVersion: 1,
        initialSelectedModel: selectedModel,
        handleStop: async () => {},
        handleSubmit,
        handleQueueMessage,
        typeahead,
        clearContentOnSubmit: false,
        clearContentBeforeSubmit: false,
        initialPermissionMode: "allowAll",
        supportsMultiAgentPromptSubmission: false,
        disableLocalStorage: true,
        isAgentWorking: true,
        isQueueingEnabled: true,
      });
      capturedController = {
        submitForm: promptBox.submitForm,
        setPermissionMode: promptBox.setPermissionMode,
      };
      return null;
    }

    await act(async () => {
      root.render(createElement(ActiveRuntimeHarness));
    });
    await act(async () => {
      capturedController?.submitForm({ saveAsDraft: false, scheduleAt: null });
      await Promise.resolve();
    });

    expect(submittedMessages).toHaveLength(0);
    expect(queuedMessages).toHaveLength(1);
    expect(mocks.appendFn).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
    container.remove();
    mocks.useThreadRuntimeReturn = null;
  });
});

describe("usePromptBox permission mode", () => {
  it("uses local selection until the view-model prop changes, then uses the synced prop on submit", async () => {
    const submittedMessages: DBUserMessage[] = [];
    const handleSubmit: HandleSubmit = async ({ userMessage }) => {
      submittedMessages.push(userMessage);
    };

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(
        createElement(Harness, {
          permissionMode: "plan",
          onSubmit: handleSubmit,
        }),
      );
    });

    await act(async () => {
      controller?.submitForm({ saveAsDraft: false, scheduleAt: null });
      await Promise.resolve();
    });
    expect(submittedMessages.at(-1)?.permissionMode).toBe("plan");

    await act(async () => {
      root?.render(
        createElement(Harness, {
          permissionMode: "allowAll",
          onSubmit: handleSubmit,
        }),
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
        createElement(Harness, {
          permissionMode: "allowAll",
          onSubmit: handleSubmit,
        }),
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
