import { ThreadInfo } from "@terragon/shared";
import { AgentIcon } from "./chat/agent-icon";
import { ensureAgent } from "@terragon/agent/utils";
import { memo } from "react";

export const ThreadAgentIcon = memo(function ThreadAgentIcon({
  thread,
}: {
  thread: ThreadInfo;
}) {
  if (thread.threadChats.length === 1) {
    const agent = thread.threadChats[0]!.agent;
    return <AgentIcon agent={agent} sessionId={null} />;
  }
  const uniqueAgents = new Set(
    thread.threadChats.map((chat) => chat.agent).map(ensureAgent),
  );
  if (uniqueAgents.size === 1) {
    return <AgentIcon agent={Array.from(uniqueAgents)[0]!} sessionId={null} />;
  }
  return null;
});
