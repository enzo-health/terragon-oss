import { describe, expect, it } from "vitest";
import {
  reasoningViewProps,
  streamingView,
  toolCallState,
  toolGroupViewProps,
  toolViewProps,
} from "./native-thread-utils";

describe("reasoningViewProps", () => {
  it("marks running status as streaming", () => {
    expect(reasoningViewProps("partial thought", { type: "running" })).toEqual({
      body: "partial thought",
      streaming: true,
      label: "Thinking",
    });
  });

  it("marks complete status as not streaming", () => {
    expect(reasoningViewProps("final thought", { type: "complete" })).toEqual({
      body: "final thought",
      streaming: false,
      label: "Thinking",
    });
  });

  it("treats incomplete status as not streaming", () => {
    expect(reasoningViewProps("", { type: "incomplete" }).streaming).toBe(
      false,
    );
  });

  it("passes the raw text through as body without mutation", () => {
    const text = "line one\n\nline two with **markdown**";
    expect(reasoningViewProps(text, { type: "running" }).body).toBe(text);
  });

  it("returns only plain values (no runtime part leaks through)", () => {
    const props = reasoningViewProps("x", { type: "running" });
    expect(typeof props.body).toBe("string");
    expect(typeof props.streaming).toBe("boolean");
    expect(typeof props.label).toBe("string");
  });
});

describe("streamingView", () => {
  it("marks running status as streaming", () => {
    expect(streamingView("partial", { type: "running" })).toEqual({
      text: "partial",
      streaming: true,
    });
  });

  it("marks any non-running status as not streaming", () => {
    expect(streamingView("done", { type: "complete" }).streaming).toBe(false);
    expect(streamingView("", { type: "incomplete" }).streaming).toBe(false);
  });

  it("passes the raw text through unchanged", () => {
    const text = "line one\n\nline two **md**";
    expect(streamingView(text, { type: "running" }).text).toBe(text);
  });
});

describe("toolCallState", () => {
  it("returns error when failed regardless of active", () => {
    expect(toolCallState(true, true)).toBe("error");
    expect(toolCallState(false, true)).toBe("error");
  });

  it("returns running when active and not failed", () => {
    expect(toolCallState(true, false)).toBe("running");
  });

  it("returns success when neither active nor failed", () => {
    expect(toolCallState(false, false)).toBe("success");
  });
});

describe("toolViewProps", () => {
  it("derives a running view that defaults open with a streaming pulse", () => {
    const props = toolViewProps({
      toolName: "Bash",
      argsText: '{"command":"ls -la"}',
      result: undefined,
      active: true,
      failed: false,
    });
    expect(props.name).toBe("Bash");
    expect(props.preview).toBe("ls -la");
    expect(props.state).toBe("running");
    expect(props.stream).toEqual({
      text: '{"command":"ls -la"}',
      streaming: true,
    });
    expect(props.resultText).toBe("");
    expect(props.errorText).toBe("");
    expect(props.defaultOpen).toBe(true);
  });

  it("derives a success view that collapses with serialized result text", () => {
    const props = toolViewProps({
      toolName: "Read",
      argsText: '{"file_path":"/tmp/x"}',
      result: { ok: true },
      active: false,
      failed: false,
    });
    expect(props.state).toBe("success");
    expect(props.stream.streaming).toBe(false);
    expect(props.resultText).toBe(JSON.stringify({ ok: true }, null, 2));
    expect(props.errorText).toBe("");
    expect(props.defaultOpen).toBe(false);
  });

  it("uses result text as error text when a failed call has a result", () => {
    const props = toolViewProps({
      toolName: "Bash",
      argsText: '{"command":"bad"}',
      result: "boom",
      active: false,
      failed: true,
    });
    expect(props.state).toBe("error");
    expect(props.errorText).toBe("boom");
  });

  it("leaves error text empty (no args mislabeled as the error) when a failed call has no result", () => {
    const props = toolViewProps({
      toolName: "Bash",
      argsText: '{"command":"bad"}',
      result: undefined,
      active: false,
      failed: true,
    });
    expect(props.state).toBe("error");
    expect(props.errorText).toBe("");
  });

  it("returns only plain values (no runtime part leaks through)", () => {
    const props = toolViewProps({
      toolName: "Grep",
      argsText: "{}",
      result: undefined,
      active: false,
      failed: false,
    });
    expect(typeof props.name).toBe("string");
    expect(typeof props.state).toBe("string");
    expect(typeof props.stream.text).toBe("string");
    expect(typeof props.stream.streaming).toBe("boolean");
    expect(typeof props.defaultOpen).toBe("boolean");
  });
});

describe("toolGroupViewProps", () => {
  const toolPart = (overrides: Record<string, unknown> = {}) => ({
    type: "tool-call",
    status: { type: "complete" },
    result: "done",
    isError: false,
    ...overrides,
  });

  it("reports a running group when any sibling is active", () => {
    const parts = [
      toolPart(),
      toolPart({ status: { type: "running" }, result: undefined }),
    ];
    const props = toolGroupViewProps(parts, 0, 1);
    expect(props.count).toBe(2);
    expect(props.state).toBe("running");
    expect(props.statusLabel).toBe("Running");
    expect(props.defaultOpen).toBe(true);
  });

  it("reports an error group (closed) when a sibling failed but none are active", () => {
    const parts = [toolPart(), toolPart({ isError: true })];
    const props = toolGroupViewProps(parts, 0, 1);
    expect(props.state).toBe("error");
    expect(props.statusLabel).toBe("Needs attention");
    expect(props.defaultOpen).toBe(false);
  });

  it("reports a completed group when all siblings succeeded", () => {
    const parts = [toolPart(), toolPart()];
    const props = toolGroupViewProps(parts, 0, 1);
    expect(props.count).toBe(2);
    expect(props.state).toBe("success");
    expect(props.statusLabel).toBe("Completed");
    expect(props.defaultOpen).toBe(false);
  });

  it("counts only tool-call parts in the index window", () => {
    const parts = [toolPart(), { type: "text", text: "hi" }, toolPart()];
    expect(toolGroupViewProps(parts, 0, 2).count).toBe(2);
    expect(toolGroupViewProps(parts, 0, 0).count).toBe(1);
  });
});
