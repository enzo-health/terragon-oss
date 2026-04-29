"use client";

import type { ToolCallMessagePartProps } from "@assistant-ui/react";
import type { AIAgent } from "@terragon/agent/types";
import type { AllToolParts, UIMessage } from "@terragon/shared";
import {
  useCallback,
  useMemo,
  type ComponentType,
  type ReactNode,
} from "react";
import { ToolPart, renderToolPart, type ToolRenderContext } from "../tool-part";
import { stringifyRuntimeValue } from "./runtime-stringify";
import { useTerragonThread } from "./thread-context";

export type RuntimeToolCallProps = ToolCallMessagePartProps<
  Record<string, unknown>,
  unknown
>;

function resolveAgent(messages: readonly UIMessage[]): AIAgent {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role === "agent") {
      return message.agent;
    }
  }
  return "claudeCode";
}

function resolveToolStatus(
  props: RuntimeToolCallProps,
): AllToolParts["status"] {
  if (props.isError || props.status.type === "incomplete") {
    return "error";
  }
  if (props.result !== undefined) {
    return "completed";
  }
  return "pending";
}

function resolveIncompleteError(
  status: RuntimeToolCallProps["status"],
): unknown {
  return status.type === "incomplete" ? status.error : undefined;
}

export function assistantToolCallPropsToToolPart(
  props: RuntimeToolCallProps,
  agent: AIAgent,
): AllToolParts {
  const baseToolPart = {
    type: "tool",
    id: props.toolCallId,
    agent,
    name: props.toolName,
    parameters: props.args,
    parts: [],
  } satisfies Omit<AllToolParts, "status" | "result">;
  const status = resolveToolStatus(props);
  if (status === "pending") {
    return {
      ...baseToolPart,
      status,
    } satisfies AllToolParts;
  }
  return {
    ...baseToolPart,
    status,
    result: stringifyRuntimeValue(
      props.result ?? resolveIncompleteError(props.status),
    ),
  } satisfies AllToolParts;
}

export function RuntimeToolRenderer(props: RuntimeToolCallProps): ReactNode {
  const ctx = useTerragonThread();
  const agent = resolveAgent(ctx.toolProps.messagesRef.current);
  const toolPart = useMemo(
    () => assistantToolCallPropsToToolPart(props, agent),
    [agent, props],
  );
  const renderChildToolPart = useCallback(
    (childToolPart: AllToolParts) => (
      <ToolPart
        toolPart={childToolPart}
        {...ctx.toolProps}
        artifactDescriptors={ctx.artifactDescriptors}
        onOpenArtifact={ctx.onOpenArtifact}
      />
    ),
    [ctx.artifactDescriptors, ctx.onOpenArtifact, ctx.toolProps],
  );
  const renderCtx = useMemo<ToolRenderContext>(
    () => ({
      ...ctx.toolProps,
      artifactDescriptors: ctx.artifactDescriptors,
      onOpenArtifact: ctx.onOpenArtifact,
      renderChildToolPart,
    }),
    [
      ctx.artifactDescriptors,
      ctx.onOpenArtifact,
      ctx.toolProps,
      renderChildToolPart,
    ],
  );

  return renderToolPart(toolPart, renderCtx);
}

export const ASSISTANT_UI_TOOL_COMPONENTS = {
  tools: {
    Override: RuntimeToolRenderer,
  },
} satisfies {
  tools: {
    Override: ComponentType<RuntimeToolCallProps>;
  };
};
