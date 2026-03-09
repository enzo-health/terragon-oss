import { randomUUID } from "node:crypto";
import { parseModelOrNull } from "@terragon/agent/utils";
import type { ISandboxSession } from "@terragon/sandbox/types";
import { bashQuote } from "@terragon/sandbox/utils";
import * as z from "zod/v4";

const DEFAULT_CODEX_GATE_MODEL = "gpt-5.3-codex-medium";
const DEFAULT_CODEX_GATE_TIMEOUT_MS = 180_000;

type CodexJsonEvent = {
  type?: string;
  message?: string;
  item?: {
    type?: string;
    text?: string;
    status?: string;
    message?: string;
  };
};

type CodexReasoningEffort = "low" | "medium" | "high" | "xhigh";

type CodexCliModelSpec = {
  cliModel: string;
  reasoningEffort: CodexReasoningEffort;
};

function resolveCodexCliModelSpec(modelName: string): CodexCliModelSpec {
  const normalizedModel = parseModelOrNull({ modelName });
  switch (normalizedModel) {
    case "gpt-5.3-codex-low":
      return { cliModel: "gpt-5.3-codex", reasoningEffort: "low" };
    case "gpt-5.3-codex-medium":
      return { cliModel: "gpt-5.3-codex", reasoningEffort: "medium" };
    case "gpt-5.3-codex-high":
      return { cliModel: "gpt-5.3-codex", reasoningEffort: "high" };
    case "gpt-5.3-codex-xhigh":
      return { cliModel: "gpt-5.3-codex", reasoningEffort: "xhigh" };
    case "gpt-5.3-codex-spark-low":
      return { cliModel: "gpt-5.3-codex-spark", reasoningEffort: "low" };
    case "gpt-5.3-codex-spark-medium":
      return { cliModel: "gpt-5.3-codex-spark", reasoningEffort: "medium" };
    case "gpt-5.3-codex-spark-high":
      return { cliModel: "gpt-5.3-codex-spark", reasoningEffort: "high" };
    default:
      throw new Error(
        `Unsupported SDLC sandbox gate model "${modelName}". Use configured gpt-5.3 codex variants.`,
      );
  }
}

function maybeParseJsonObject(rawText: string): unknown {
  try {
    return JSON.parse(rawText);
  } catch {
    return null;
  }
}

function extractJsonFromText(rawText: string): unknown {
  const direct = maybeParseJsonObject(rawText);
  if (direct !== null) {
    return direct;
  }

  const fencedMatches = [...rawText.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)];
  for (const match of fencedMatches.reverse()) {
    const fencedCandidate = match[1]?.trim();
    if (!fencedCandidate) {
      continue;
    }
    const parsed = maybeParseJsonObject(fencedCandidate);
    if (parsed !== null) {
      return parsed;
    }
  }

  const firstBrace = rawText.indexOf("{");
  const lastBrace = rawText.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const braceCandidate = rawText.slice(firstBrace, lastBrace + 1);
    const parsed = maybeParseJsonObject(braceCandidate);
    if (parsed !== null) {
      return parsed;
    }
  }

  throw new Error("Could not parse a JSON object from Codex gate output");
}

function extractLatestAgentMessage(rawStdout: string): string | null {
  const agentMessages: string[] = [];
  const stdoutLines = rawStdout.split("\n");
  for (const line of stdoutLines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    let event: CodexJsonEvent | null = null;
    try {
      event = JSON.parse(trimmed) as CodexJsonEvent;
    } catch {
      continue;
    }

    if (event.type === "error") {
      const message = event.message?.trim();
      throw new Error(message || "Codex gate reported an error event");
    }

    if (
      (event.type === "item.completed" || event.type === "item.updated") &&
      event.item?.type === "agent_message" &&
      typeof event.item.text === "string" &&
      event.item.text.trim().length > 0
    ) {
      agentMessages.push(event.item.text.trim());
    }
  }

  return agentMessages.length > 0
    ? agentMessages[agentMessages.length - 1]!
    : null;
}

export async function runStructuredCodexGateInSandbox<TOutput>({
  session,
  gateName,
  schema,
  prompt,
  model = DEFAULT_CODEX_GATE_MODEL,
  timeoutMs = DEFAULT_CODEX_GATE_TIMEOUT_MS,
}: {
  session: ISandboxSession;
  gateName: string;
  schema: z.ZodType<TOutput>;
  prompt: string;
  model?: string;
  timeoutMs?: number;
}): Promise<TOutput> {
  const codexModelSpec = resolveCodexCliModelSpec(model);
  const promptFilePath = `/tmp/sdlc-${gateName}-prompt-${randomUUID()}.txt`;
  const runCommand = [
    "cat",
    bashQuote(promptFilePath),
    "|",
    // Safe here because this executes inside an isolated remote sandbox session.
    "codex exec",
    "--dangerously-bypass-approvals-and-sandbox",
    "--json",
    "--model",
    bashQuote(codexModelSpec.cliModel),
    "--config",
    bashQuote(`model_reasoning_effort=${codexModelSpec.reasoningEffort}`),
    "-c",
    bashQuote("suppress_unstable_features_warning=true"),
  ].join(" ");

  try {
    await session.writeTextFile(promptFilePath, prompt);
    const rawStdout = await session.runCommand(runCommand, {
      cwd: session.repoDir,
      timeoutMs,
    });
    const latestAgentMessage = extractLatestAgentMessage(rawStdout);
    if (!latestAgentMessage) {
      throw new Error(
        "No agent message found in Codex stdout; cannot safely parse gate output.",
      );
    }
    const parsed = extractJsonFromText(latestAgentMessage);
    return schema.parse(parsed);
  } catch (error) {
    console.warn("[sdlc-pre-pr-review] sandbox Codex gate failed", {
      gateName,
      model,
      error,
    });
    throw error;
  } finally {
    await session
      .runCommand(`rm -f ${bashQuote(promptFilePath)}`, {
        cwd: session.repoDir,
      })
      .catch((cleanupError: unknown) => {
        console.debug(
          "[sdlc-pre-pr-review] failed to clean up Codex gate prompt file",
          {
            gateName,
            promptFilePath,
            cleanupError,
          },
        );
      });
  }
}
