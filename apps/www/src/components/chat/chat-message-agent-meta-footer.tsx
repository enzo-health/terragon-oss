"use client";

import React from "react";
import { UIAgentMessage } from "@terragon/shared";
import { formatDuration } from "./chat-message.utils";

export function AgentMetaFooter({
  meta,
}: {
  meta: NonNullable<UIAgentMessage["meta"]>;
}) {
  const parts: string[] = [];
  if (meta.duration_ms > 0) {
    parts.push(formatDuration(meta.duration_ms));
  }
  if (meta.num_turns > 0) {
    parts.push(`${meta.num_turns} turn${meta.num_turns === 1 ? "" : "s"}`);
  }
  if (parts.length === 0) return null;
  return (
    <div className="text-xs text-muted-foreground/60 font-mono pt-1 select-none">
      {parts.join(" · ")}
    </div>
  );
}
