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

import { TerragonThreadErrorBoundary } from "./terragon-thread";

function Boom(): never {
  throw new Error("boom-from-child");
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

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
