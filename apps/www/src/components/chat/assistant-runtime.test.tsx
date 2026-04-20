import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi, beforeEach } from "vitest";
import type { HttpAgent } from "@ag-ui/client";

const useAgUiRuntimeSpy = vi.fn();

vi.mock("@assistant-ui/react-ag-ui", () => ({
  useAgUiRuntime: (options: unknown) => {
    useAgUiRuntimeSpy(options);
    return { __mock: true } as unknown;
  },
}));

import { useTerragonRuntime } from "./assistant-runtime";

function HookHarness({
  args,
}: {
  args: Parameters<typeof useTerragonRuntime>[0];
}) {
  useTerragonRuntime(args);
  return <div />;
}

describe("useTerragonRuntime", () => {
  beforeEach(() => {
    useAgUiRuntimeSpy.mockClear();
  });

  it("forwards agent + showThinking:true to useAgUiRuntime", () => {
    const agent = {} as HttpAgent;
    renderToStaticMarkup(<HookHarness args={{ agent }} />);
    expect(useAgUiRuntimeSpy).toHaveBeenCalledTimes(1);
    const opts = useAgUiRuntimeSpy.mock.calls[0]?.[0] as {
      agent: HttpAgent;
      showThinking: boolean;
    };
    expect(opts.agent).toBe(agent);
    expect(opts.showThinking).toBe(true);
  });

  it("passes onError through when provided", () => {
    const agent = {} as HttpAgent;
    const onError = vi.fn();
    renderToStaticMarkup(<HookHarness args={{ agent, onError }} />);
    const opts = useAgUiRuntimeSpy.mock.calls[0]?.[0] as {
      onError?: (e: Error) => void;
    };
    expect(opts.onError).toBe(onError);
  });

  it("wraps async onCancel into a void-returning callback", () => {
    const agent = {} as HttpAgent;
    const onCancel = vi.fn().mockResolvedValue(undefined);
    renderToStaticMarkup(<HookHarness args={{ agent, onCancel }} />);
    const opts = useAgUiRuntimeSpy.mock.calls[0]?.[0] as {
      onCancel?: () => void;
    };
    expect(typeof opts.onCancel).toBe("function");
    opts.onCancel?.();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("omits onCancel/onError when not provided", () => {
    const agent = {} as HttpAgent;
    renderToStaticMarkup(<HookHarness args={{ agent }} />);
    const opts = useAgUiRuntimeSpy.mock.calls[0]?.[0] as {
      onCancel?: unknown;
      onError?: unknown;
    };
    expect(opts.onCancel).toBeUndefined();
    expect(opts.onError).toBeUndefined();
  });
});
