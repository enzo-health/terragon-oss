/* @vitest-environment jsdom */

import type { AIModel } from "@terragon/agent/types";
import type { DBUserMessage } from "@terragon/shared";
import type { JSONContent } from "@tiptap/react";
import { act, createElement, useReducer } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmptyThreadViewSnapshot } from "../chat/thread-view-model/legacy-db-message-adapter";
import {
  createInitialThreadViewModelState,
  projectThreadViewModel,
  threadViewModelReducer,
} from "../chat/thread-view-model/reducer";
import { createOptimisticPermissionModeUpdatedEvent } from "../chat/thread-view-model/optimistic-events";
import { ThreadPromptBox } from "./thread-promptbox";
import type { HandleSubmit } from "./use-promptbox";

type SimplePromptBoxCapture = {
  permissionMode: "allowAll" | "plan";
  onPermissionModeChange: (mode: "allowAll" | "plan") => void;
  submitForm: (args: {
    saveAsDraft: boolean;
    scheduleAt: number | null;
  }) => void;
};

const selectedModel = "claude-3-5-sonnet-20241022" as AIModel;
const editorJson: JSONContent = {
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "toggle plan mode" }],
    },
  ],
};

const mocks = vi.hoisted(() => ({
  latestPromptBox: null as SimplePromptBoxCapture | null,
  clearContent: vi.fn(),
  dispatch: vi.fn(),
}));

vi.mock("next/dynamic", () => ({
  default: () => () => null,
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

vi.mock("usehooks-ts", async () => {
  const react = await import("react");
  return {
    useLocalStorage: <T,>(_key: string, initialValue: T) => {
      const [value, setValue] = react.useState(initialValue);
      const removeRef = react.useRef(() => {});
      return [value, setValue, removeRef.current] as const;
    },
  };
});

vi.mock("./typeahead/repository-cache", () => ({
  useRepositoryCache: () => ({
    getSuggestions: async () => [],
  }),
}));

vi.mock("@tiptap/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tiptap/react")>();
  return {
    ...actual,
    useEditor: () => ({
      getText: () => "toggle plan mode",
      getJSON: () => editorJson,
      getHTML: () => "<p>toggle plan mode</p>",
      isEmpty: false,
      isFocused: false,
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

vi.mock("./simple-promptbox", () => ({
  SimplePromptBox: (props: SimplePromptBoxCapture) => {
    mocks.latestPromptBox = props;
    return null;
  },
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount();
    });
    root = null;
  }
  container?.remove();
  container = null;
  mocks.latestPromptBox = null;
  vi.clearAllMocks();
});

function Harness({ onSubmit }: { onSubmit: HandleSubmit }): null {
  const [state, dispatch] = useReducer(
    threadViewModelReducer,
    createEmptyThreadViewSnapshot({ agent: "claudeCode" }),
    createInitialThreadViewModelState,
  );
  const viewModel = projectThreadViewModel(state);

  return (
    <ThreadPromptBox
      threadId="thread-1"
      threadChatId="chat-1"
      sandboxId="sandbox-1"
      status="complete"
      repoFullName="terragon/oss"
      branchName="main"
      prStatus={null}
      prChecksStatus={null}
      githubPRNumber={null}
      agent="claudeCode"
      agentVersion={1}
      lastUsedModel={selectedModel}
      permissionMode={viewModel.permissionMode ?? "allowAll"}
      onPermissionModeChange={(mode) => {
        dispatch(createOptimisticPermissionModeUpdatedEvent(mode));
      }}
      handleStop={async () => {}}
      handleSubmit={onSubmit}
      queuedMessages={null}
      handleQueueMessage={onSubmit}
      onUpdateQueuedMessage={() => {}}
    />
  );
}

describe("ThreadPromptBox permission mode ownership", () => {
  it("dispatches user mode changes through ThreadViewModel and submits with the VM-updated mode", async () => {
    const submittedMessages: DBUserMessage[] = [];
    const handleSubmit: HandleSubmit = async ({ userMessage }) => {
      submittedMessages.push(userMessage);
    };

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root?.render(createElement(Harness, { onSubmit: handleSubmit }));
    });

    expect(mocks.latestPromptBox?.permissionMode).toBe("allowAll");

    await act(async () => {
      mocks.latestPromptBox?.onPermissionModeChange("plan");
      await Promise.resolve();
    });

    expect(mocks.latestPromptBox?.permissionMode).toBe("plan");

    await act(async () => {
      mocks.latestPromptBox?.submitForm({
        saveAsDraft: false,
        scheduleAt: null,
      });
      await Promise.resolve();
    });

    expect(submittedMessages.at(-1)?.permissionMode).toBe("plan");
  });
});
