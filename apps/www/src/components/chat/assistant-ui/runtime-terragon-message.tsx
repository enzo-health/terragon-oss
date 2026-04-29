"use client";

import { MessagePrimitive } from "@assistant-ui/react";
import type { AIAgent } from "@terragon/agent/types";
import type { UIMessage } from "@terragon/shared";
import { memo } from "react";
import { cn } from "@/lib/utils";
import { AgentMetaFooter } from "../chat-message-agent-meta-footer";
import { MessageToolbar } from "../chat-message-toolbar";
import { type RuntimeMessagePartState } from "./runtime-part-conversion";
import { RuntimePartRenderer } from "./runtime-part-renderer";
import { TerragonSystemMessage } from "./system-message";
import { useTerragonThread } from "./thread-context";

type RuntimeTerragonMessageProps = {
  message: UIMessage;
  messageIndex: number;
  isLatestMessage: boolean;
  isFirstUserMessage: boolean;
  isLatestAgentMessage: boolean;
  agent: AIAgent;
};

export const RuntimeTerragonMessage = memo(function RuntimeTerragonMessage({
  message,
  messageIndex,
  isLatestMessage,
  isFirstUserMessage,
  isLatestAgentMessage,
  agent,
}: RuntimeTerragonMessageProps) {
  const ctx = useTerragonThread();
  const rowIsAgentWorking =
    ctx.isAgentWorking && isLatestMessage && message.role === "agent";
  const partAgent = message.role === "agent" ? message.agent : agent;

  if (message.role === "system") {
    return (
      <TerragonSystemMessage
        message={message}
        messageIndex={messageIndex}
        isLatestMessage={isLatestMessage}
      />
    );
  }

  return (
    <div
      className="flex flex-col gap-1 group [scroll-margin-top:6rem]"
      data-message-index={messageIndex}
    >
      <div
        style={{ overflowAnchor: "none" }}
        className={cn(
          "w-full break-words animate-in fade-in slide-in-from-bottom-2",
          message.role === "user"
            ? "ml-auto w-fit max-w-[90%] sm:max-w-[85%] rounded-[calc(var(--radius)+0.15rem)] bg-card text-card-foreground px-4 py-3 shadow-[var(--shadow-warm-lift)] md:px-5"
            : "mr-auto",
        )}
      >
        <div className="flex flex-col gap-3 text-sm leading-relaxed">
          <div className="flex flex-col gap-3">
            <MessagePrimitive.Parts>
              {({ part }: { part: RuntimeMessagePartState }) => (
                <RuntimePartRenderer
                  part={part}
                  agent={partAgent}
                  isLatest={isLatestMessage}
                  isAgentWorking={rowIsAgentWorking}
                  artifactDescriptors={ctx.artifactDescriptors}
                  onOpenArtifact={ctx.onOpenArtifact}
                  messagePartProps={ctx.messagePartProps}
                />
              )}
            </MessagePrimitive.Parts>
            {message.role === "agent" && message.meta ? (
              <AgentMetaFooter meta={message.meta} />
            ) : null}
          </div>
        </div>
      </div>
      <MessageToolbar
        message={message}
        messageIndex={messageIndex}
        isFirstUserMessage={isFirstUserMessage}
        isLatestAgentMessage={isLatestAgentMessage}
        isAgentWorking={ctx.isAgentWorking}
        redoDialogData={isFirstUserMessage ? ctx.redoDialogData : undefined}
        forkDialogData={isLatestAgentMessage ? ctx.forkDialogData : undefined}
      />
    </div>
  );
});
