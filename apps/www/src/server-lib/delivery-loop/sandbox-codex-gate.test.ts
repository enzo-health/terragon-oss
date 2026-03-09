import { randomUUID } from "node:crypto";
import { parseModelOrNull } from "@terragon/agent/utils";
import type { ISandboxSession } from "@terragon/sandbox/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as z from "zod/v4";
import { runStructuredCodexGateInSandbox } from "./sandbox-codex-gate";

vi.mock("node:crypto", () => ({
  randomUUID: vi.fn(),
}));

vi.mock("@terragon/agent/utils", () => ({
  parseModelOrNull: vi.fn(),
}));

function makeSession({
  runCommand,
  writeTextFile,
}: {
  runCommand: (
    command: string,
    options: { cwd: string; timeoutMs?: number },
  ) => Promise<string>;
  writeTextFile: (path: string, content: string) => Promise<void>;
}): ISandboxSession {
  return {
    repoDir: "/repo",
    runCommand,
    writeTextFile,
  } as unknown as ISandboxSession;
}

describe("runStructuredCodexGateInSandbox", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(randomUUID).mockReturnValue(
      "00000000-0000-0000-0000-000000000001",
    );
    vi.mocked(parseModelOrNull).mockReturnValue("gpt-5.3-codex-medium");
  });

  it("uses the configured codex CLI model and parses JSON from latest agent message", async () => {
    const runCommand = vi
      .fn<
        (
          command: string,
          options: { cwd: string; timeoutMs?: number },
        ) => Promise<string>
      >()
      .mockResolvedValueOnce(
        JSON.stringify({
          type: "item.completed",
          item: {
            type: "agent_message",
            text: '{"gatePassed":true}',
          },
        }),
      )
      .mockResolvedValueOnce("");
    const writeTextFile = vi
      .fn<(path: string, content: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    const session = makeSession({ runCommand, writeTextFile });

    const result = await runStructuredCodexGateInSandbox({
      session,
      gateName: "deep-review",
      schema: z.object({ gatePassed: z.boolean() }),
      prompt: "gate prompt",
    });

    expect(result).toEqual({ gatePassed: true });
    expect(writeTextFile).toHaveBeenCalledWith(
      "/tmp/sdlc-deep-review-prompt-00000000-0000-0000-0000-000000000001.txt",
      "gate prompt",
    );
    const firstCommand = runCommand.mock.calls[0]?.[0] ?? "";
    expect(firstCommand).toContain(
      "--dangerously-bypass-approvals-and-sandbox",
    );
    expect(firstCommand).toContain("--model 'gpt-5.3-codex'");
    expect(firstCommand).toContain("--config 'model_reasoning_effort=medium'");
  });

  it("throws when no agent message is present in codex stdout", async () => {
    const runCommand = vi
      .fn<
        (
          command: string,
          options: { cwd: string; timeoutMs?: number },
        ) => Promise<string>
      >()
      .mockResolvedValueOnce(
        JSON.stringify({
          type: "item.completed",
          item: {
            type: "tool_result",
            text: '{"gatePassed":true}',
          },
        }),
      )
      .mockResolvedValueOnce("");
    const writeTextFile = vi
      .fn<(path: string, content: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    const session = makeSession({ runCommand, writeTextFile });

    await expect(
      runStructuredCodexGateInSandbox({
        session,
        gateName: "carmack-review",
        schema: z.object({ gatePassed: z.boolean() }),
        prompt: "gate prompt",
      }),
    ).rejects.toThrow(
      "No agent message found in Codex stdout; cannot safely parse gate output.",
    );
  });

  it("logs prompt cleanup failures without masking a successful gate result", async () => {
    const runCommand = vi
      .fn<
        (
          command: string,
          options: { cwd: string; timeoutMs?: number },
        ) => Promise<string>
      >()
      .mockResolvedValueOnce(
        JSON.stringify({
          type: "item.completed",
          item: {
            type: "agent_message",
            text: '{"gatePassed":true}',
          },
        }),
      )
      .mockRejectedValueOnce(new Error("cleanup failed"));
    const writeTextFile = vi
      .fn<(path: string, content: string) => Promise<void>>()
      .mockResolvedValue(undefined);
    const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const session = makeSession({ runCommand, writeTextFile });

    const result = await runStructuredCodexGateInSandbox({
      session,
      gateName: "deep-review",
      schema: z.object({ gatePassed: z.boolean() }),
      prompt: "gate prompt",
    });

    expect(result).toEqual({ gatePassed: true });
    expect(debugSpy).toHaveBeenCalledTimes(1);
    debugSpy.mockRestore();
  });
});
