import { describe, expect, it } from "vitest";
import type { DBMessage } from "@leo/shared";
import { computeShouldShowApprove } from "./hooks";

function msg(
  overrides: Partial<DBMessage> & { id: string; type: string },
): DBMessage {
  return overrides as unknown as DBMessage;
}

describe("computeShouldShowApprove", () => {
  it("returns false when canApprove is false", () => {
    expect(
      computeShouldShowApprove({
        canApprove: false,
        toolPartId: "exit-1",
        messages: [
          msg({
            id: "exit-1",
            type: "tool-call",
            name: "ExitPlanMode",
          }),
        ],
      }),
    ).toBe(false);
  });

  it("returns false when toolPartId is undefined", () => {
    expect(
      computeShouldShowApprove({
        canApprove: true,
        toolPartId: undefined,
        messages: [
          msg({
            id: "exit-1",
            type: "tool-call",
            name: "ExitPlanMode",
          }),
        ],
      }),
    ).toBe(false);
  });

  it("returns true when toolPartId matches the last ExitPlanMode before any user message", () => {
    expect(
      computeShouldShowApprove({
        canApprove: true,
        toolPartId: "exit-1",
        messages: [
          msg({
            id: "exit-1",
            type: "tool-call",
            name: "ExitPlanMode",
          }),
        ],
      }),
    ).toBe(true);
  });

  it("returns false when toolPartId does not match the last ExitPlanMode", () => {
    expect(
      computeShouldShowApprove({
        canApprove: true,
        toolPartId: "exit-old",
        messages: [
          msg({
            id: "exit-old",
            type: "tool-call",
            name: "ExitPlanMode",
          }),
          msg({
            id: "exit-new",
            type: "tool-call",
            name: "ExitPlanMode",
          }),
        ],
      }),
    ).toBe(false);
  });

  it("returns false when a user message appears after ExitPlanMode", () => {
    expect(
      computeShouldShowApprove({
        canApprove: true,
        toolPartId: "exit-1",
        messages: [
          msg({
            id: "exit-1",
            type: "tool-call",
            name: "ExitPlanMode",
          }),
          msg({ id: "user-1", type: "user" }),
        ],
      }),
    ).toBe(false);
  });

  it("returns true when non-ExitPlanMode tool calls follow the matching ExitPlanMode", () => {
    expect(
      computeShouldShowApprove({
        canApprove: true,
        toolPartId: "exit-1",
        messages: [
          msg({
            id: "exit-1",
            type: "tool-call",
            name: "ExitPlanMode",
          }),
          msg({
            id: "other-tool",
            type: "tool-call",
            name: "Read",
          }),
        ],
      }),
    ).toBe(true);
  });

  it("returns false for empty messages", () => {
    expect(
      computeShouldShowApprove({
        canApprove: true,
        toolPartId: "exit-1",
        messages: [],
      }),
    ).toBe(false);
  });
});
