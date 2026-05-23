/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { copyTextToClipboard } from "./clipboard";

const originalClipboard = navigator.clipboard;
const originalExecCommand = document.execCommand;

function setClipboard(writeText?: (text: string) => Promise<void>): void {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: writeText ? { writeText } : undefined,
  });
}

describe("copyTextToClipboard", () => {
  beforeEach(() => {
    document.execCommand = vi.fn(() => true);
  });

  afterEach(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: originalClipboard,
    });
    document.execCommand = originalExecCommand;
    vi.restoreAllMocks();
  });

  it("uses navigator.clipboard when available", async () => {
    const writeText = vi.fn(async () => undefined);
    setClipboard(writeText);

    await copyTextToClipboard("hello");

    expect(writeText).toHaveBeenCalledWith("hello");
    expect(document.execCommand).not.toHaveBeenCalled();
  });

  it("falls back to selection copy when navigator clipboard rejects", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("NotAllowedError");
    });
    setClipboard(writeText);

    await copyTextToClipboard("hello");

    expect(writeText).toHaveBeenCalledWith("hello");
    expect(document.execCommand).toHaveBeenCalledWith("copy");
  });

  it("falls back to selection copy when navigator clipboard is unavailable", async () => {
    setClipboard();

    await copyTextToClipboard("hello");

    expect(document.execCommand).toHaveBeenCalledWith("copy");
  });
});
