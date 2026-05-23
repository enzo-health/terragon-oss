/* @vitest-environment jsdom */

/**
 * Tests for `<TerragonThreadErrorBoundary/>`. Asserts:
 *
 *   1. When a child throws on mount, the boundary captures the error and
 *      renders the `<ChatError/>` fallback (we look for the rendered error
 *      info text rather than coupling to the component identity).
 *   2. `componentDidCatch` is invoked — verified by spying on `console.error`
 *      since the production implementation logs there.
 *
 * We use `react-dom/client` + `act` so React fires the boundary's
 * `getDerivedStateFromError` / `componentDidCatch` lifecycle methods, which
 * `react-dom/server` does not.
 */

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// `chat-message-toolbar` (transitively imported by `terragon-thread`) pulls
// in the audio transcription server action which constructs a real OpenAI
// client at module load. Stub it out — we never exercise transcription.
vi.mock("@/server-actions/transcribe-audio", () => ({
  transcribeAudio: vi.fn(),
}));

vi.mock("./system-message", async () => {
  const { createElement: createReactElement } = await import("react");

  type MockPart = { text?: string };
  type MockMessage = { parts?: MockPart[] };

  return {
    TerragonSystemMessage: ({ message }: { message: MockMessage }) =>
      createReactElement(
        "div",
        { "data-testid": "system-message" },
        message.parts
          ?.map((part) => part.text)
          .filter((text) => typeof text === "string" && text.length > 0)
          .join(" ") ?? "",
      ),
  };
});

import {
  resolveTerragonRuntimeLoadConfig,
  resolveTerragonThreadErrorProps,
  TerragonThreadErrorBoundary,
} from "./terragon-thread";
import {
  getWorkingMessageSlotClassName,
  TerragonTranscriptSurface,
} from "./terragon-transcript-surface";
import { createInitialThreadMetaSnapshot } from "../thread-view-model/snapshot-adapter";

function Boom(): never {
  throw new Error("boom-from-child");
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation(
      (query: string): MediaQueryList => ({
        matches: false,
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
    ),
  });
});

function mount(element: React.ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(element);
  });
}

afterEach(() => {
  if (root) {
    act(() => root!.unmount());
    root = null;
  }
  if (container) {
    container.remove();
    container = null;
  }
  vi.restoreAllMocks();
});

describe("TerragonThreadErrorBoundary", () => {
  // React itself logs the caught error to console.error during dev. We
  // silence the noise via a spy so test output stays clean AND we can
  // assert componentDidCatch fired by checking the spy received our log.
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("renders the ChatError fallback when a child throws on mount", () => {
    mount(
      createElement(
        TerragonThreadErrorBoundary,
        { threadStatus: null, isReadOnly: false },
        createElement(Boom),
      ),
    );

    // The fallback path passes `error.message` through as `errorInfo` to
    // <ChatError/>, which renders that string into the DOM.
    const html = container!.innerHTML;
    expect(html).toContain("boom-from-child");
  });

  it("invokes componentDidCatch (verified via console.error log)", () => {
    mount(
      createElement(
        TerragonThreadErrorBoundary,
        { threadStatus: null, isReadOnly: false },
        createElement(Boom),
      ),
    );

    // The boundary's componentDidCatch logs `"TerragonThread crashed:"`. If
    // the lifecycle wasn't called, this assertion fails. (React itself also
    // logs separate uncaught-error noise into console.error; we only care
    // that *our* log fires.)
    const ourLogCalls = consoleErrorSpy.mock.calls.filter(
      (call) =>
        typeof call[0] === "string" &&
        call[0].includes("TerragonThread crashed"),
    );
    expect(ourLogCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("renders children when no error is thrown", () => {
    mount(
      createElement(
        TerragonThreadErrorBoundary,
        { threadStatus: null, isReadOnly: false },
        createElement("div", { "data-testid": "ok" }, "happy path"),
      ),
    );

    expect(container!.querySelector('[data-testid="ok"]')).not.toBeNull();
    expect(container!.innerHTML).toContain("happy path");
  });
});

describe("TerragonTranscriptSurface", () => {
  it("renders a non-transcript hydration state while runtime history is loading", () => {
    mount(
      createElement(TerragonTranscriptSurface, {
        lifecycleMessages: [],
        isRuntimeHydrating: true,
        messages: [
          {
            id: "db-row-1",
            role: "user",
            parts: [{ type: "text", text: "DB fallback should not render" }],
          },
        ],
        latestAgentMessageIndex: -1,
        chatAgent: "codex",
        reserveWorkingMessageSlot: false,
        showWorkingMessage: false,
        threadStatus: null,
        reattemptQueueAt: null,
        metaSnapshot: createInitialThreadMetaSnapshot(),
        passiveWait: null,
        threadId: "thread-1",
      }),
    );

    expect(container!.textContent).toContain("Connecting to live task");
    expect(container!.textContent).not.toContain(
      "DB fallback should not render",
    );
  });

  it("renders a visible history-load error instead of a blank transcript", () => {
    mount(
      createElement(TerragonTranscriptSurface, {
        lifecycleMessages: [],
        isRuntimeHydrating: false,
        messages: [],
        latestAgentMessageIndex: -1,
        chatAgent: "codex",
        reserveWorkingMessageSlot: false,
        showWorkingMessage: false,
        threadStatus: null,
        reattemptQueueAt: null,
        metaSnapshot: createInitialThreadMetaSnapshot(),
        passiveWait: null,
        threadId: "thread-1",
        errorType: "history-load",
        errorInfo: "Failed to load task history",
      }),
    );

    expect(container!.textContent).toContain("Failed to load task history");
  });

  it("reserves checklist height for the booting footer", () => {
    mount(
      createElement(TerragonTranscriptSurface, {
        lifecycleMessages: [],
        isRuntimeHydrating: false,
        messages: [],
        latestAgentMessageIndex: -1,
        chatAgent: "codex",
        reserveWorkingMessageSlot: true,
        showWorkingMessage: false,
        threadStatus: "booting",
        bootingSubstatus: "provisioning",
        reattemptQueueAt: null,
        metaSnapshot: createInitialThreadMetaSnapshot(),
        passiveWait: null,
        threadId: "thread-1",
      }),
    );

    expect(container!.querySelector(".min-h-\\[168px\\]")).not.toBeNull();
  });

  it("uses expanded working-lane height for the booting checklist", () => {
    expect(
      getWorkingMessageSlotClassName({
        hasTranscriptMessages: false,
        threadStatus: "booting",
      }),
    ).toBe("min-h-[168px]");
  });

  it("uses compact working-lane height after transcript messages render", () => {
    mount(
      createElement(TerragonTranscriptSurface, {
        lifecycleMessages: [],
        isRuntimeHydrating: false,
        messages: [
          {
            id: "db-row-1",
            role: "system",
            parts: [{ type: "text", text: "Prompt already in transcript" }],
          },
        ],
        latestAgentMessageIndex: -1,
        chatAgent: "codex",
        reserveWorkingMessageSlot: true,
        showWorkingMessage: true,
        threadStatus: "working",
        reattemptQueueAt: null,
        metaSnapshot: createInitialThreadMetaSnapshot(),
        passiveWait: null,
        threadId: "thread-1",
      }),
    );

    expect(container!.textContent).toContain("Prompt already in transcript");
    expect(container!.querySelector(".min-h-\\[168px\\]")).toBeNull();
    expect(container!.querySelector(".min-h-11")).not.toBeNull();
  });
});

describe("resolveTerragonThreadErrorProps", () => {
  it("keeps caller error props paired ahead of history-load failures", () => {
    expect(
      resolveTerragonThreadErrorProps({
        callerError: "Sandbox failed",
        callerErrorType: "sandbox",
        historyLoadError: "History failed",
        runtimeError: "Runtime failed",
      }),
    ).toEqual({ errorType: "sandbox" });
  });

  it("uses history-load error type and info only without a caller error", () => {
    expect(
      resolveTerragonThreadErrorProps({
        callerError: null,
        historyLoadError: "History failed",
        runtimeError: "Runtime failed",
      }),
    ).toEqual({
      errorType: "history-load",
      errorInfo: "History failed",
    });
  });

  it("uses a generic runtime error type for non-history runtime failures", () => {
    expect(
      resolveTerragonThreadErrorProps({
        callerError: null,
        historyLoadError: null,
        runtimeError: "Cancel failed",
      }),
    ).toEqual({
      errorType: "runtime",
      errorInfo: "Cancel failed",
    });
  });
});

describe("resolveTerragonRuntimeLoadConfig", () => {
  it("loads completed task history without resuming the AG-UI stream", () => {
    expect(
      resolveTerragonRuntimeLoadConfig({
        isAgentWorking: false,
        threadChatId: "chat-1",
      }),
    ).toEqual({
      resumeOnLoad: false,
      historyLoadKey: "chat-1:idle",
      shouldApplyReplayCursor: false,
    });
  });

  it("resumes active task history with a stable active load key", () => {
    expect(
      resolveTerragonRuntimeLoadConfig({
        isAgentWorking: true,
        threadChatId: "chat-1",
      }),
    ).toEqual({
      resumeOnLoad: true,
      historyLoadKey: "chat-1:active",
      shouldApplyReplayCursor: true,
    });
  });
});
