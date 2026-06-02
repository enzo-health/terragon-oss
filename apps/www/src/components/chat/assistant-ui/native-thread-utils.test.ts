import { describe, expect, it } from "vitest";
import { reasoningViewProps } from "./native-thread-utils";

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
