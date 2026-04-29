import type { ThreadMessage } from "@assistant-ui/react";
import type { AIAgent } from "@terragon/agent/types";
import type { UIMessage } from "@terragon/shared";

export type RuntimeTranscriptProjection = {
  source: "runtime";
  messages: UIMessage[];
};

function runtimeRoleToUiRole(message: ThreadMessage): UIMessage["role"] | null {
  if (message.role === "user") return "user";
  if (message.role === "assistant") return "agent";
  return null;
}

function buildMinimalRuntimeMessage(params: {
  runtimeMessage: ThreadMessage;
  agent: AIAgent;
}): UIMessage | null {
  const role = runtimeRoleToUiRole(params.runtimeMessage);
  if (role === "user") {
    return { id: params.runtimeMessage.id, role: "user", parts: [] };
  }
  if (role === "agent") {
    return {
      id: params.runtimeMessage.id,
      role: "agent",
      agent: params.agent,
      parts: [],
    };
  }
  return null;
}

export function projectRuntimeOwnedRows(params: {
  runtimeMessages: readonly ThreadMessage[];
  projectedTranscript: RuntimeTranscriptProjection;
  agent: AIAgent;
}): RuntimeTranscriptProjection {
  const { runtimeMessages, projectedTranscript, agent } = params;
  if (runtimeMessages.length === 0) return projectedTranscript;

  const projectedById = new Map(
    projectedTranscript.messages.map((message) => [message.id, message]),
  );
  const messages: UIMessage[] = [];
  for (const runtimeMessage of runtimeMessages) {
    const role = runtimeRoleToUiRole(runtimeMessage);
    if (role === null) return projectedTranscript;

    const projected = projectedById.get(runtimeMessage.id);
    if (projected?.role === role) {
      messages.push(projected);
      continue;
    }

    const minimal = buildMinimalRuntimeMessage({ runtimeMessage, agent });
    if (!minimal) return projectedTranscript;
    messages.push(minimal);
  }

  return { source: "runtime", messages };
}
