/* @vitest-environment jsdom */

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UIMessage } from "@terragon/shared";

const toastSuccess = vi.fn();
const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: {
    success: (...args: unknown[]) => toastSuccess(...args),
    error: (...args: unknown[]) => toastError(...args),
  },
}));

vi.mock("@/hooks/use-feature-flag", () => ({
  useFeatureFlag: () => false,
}));

vi.mock("./redo-task-dialog", () => ({
  RedoTaskDialog: () => null,
}));

vi.mock("./fork-task-dialog", () => ({
  ForkTaskDialog: () => null,
}));

import { MessageToolbar } from "./chat-message-toolbar";

let container: HTMLDivElement | null = null;
let root: Root | null = null;
const originalClipboard = navigator.clipboard;
const originalExecCommand = document.execCommand;

function mount(message: UIMessage): void {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <MessageToolbar
        message={message}
        messageIndex={0}
        isFirstUserMessage={false}
        isLatestAgentMessage={false}
        isAgentWorking={false}
      />,
    );
  });
}

describe("MessageToolbar", () => {
  beforeEach(() => {
    toastSuccess.mockClear();
    toastError.mockClear();
    document.execCommand = vi.fn(() => true);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
      root = null;
    }
    container?.remove();
    container = null;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: originalClipboard,
    });
    document.execCommand = originalExecCommand;
    vi.restoreAllMocks();
  });

  it("falls back when navigator clipboard rejects while copying a message", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("NotAllowedError");
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const message: UIMessage = {
      id: "message-1",
      role: "agent",
      agent: "codex",
      parts: [{ type: "text", text: "hello from the agent" }],
    };
    mount(message);

    const button = container?.querySelector<HTMLButtonElement>(
      'button[aria-label="Copy message"]',
    );
    expect(button).toBeTruthy();
    await act(async () => {
      button?.click();
    });

    expect(writeText).toHaveBeenCalledWith("hello from the agent");
    expect(document.execCommand).toHaveBeenCalledWith("copy");
    expect(toastSuccess).toHaveBeenCalledWith("Copied");
    expect(toastError).not.toHaveBeenCalled();
  });
});
