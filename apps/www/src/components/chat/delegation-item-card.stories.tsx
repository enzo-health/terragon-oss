import type { Story, StoryDefault } from "@ladle/react";
import { DelegationItemCard } from "./delegation-item-card";
import type { DBDelegationMessage } from "@terragon/shared";

export default {
  title: "Chat/DelegationItemCard",
} satisfies StoryDefault;

const baseDelegation: DBDelegationMessage = {
  type: "delegation",
  model: null,
  delegationId: "del-001",
  tool: "spawn",
  status: "initiated",
  senderThreadId: "thread-sender",
  receiverThreadIds: ["thread-a", "thread-b"],
  prompt:
    "Implement the authentication module with JWT tokens and refresh token rotation. Make sure to write tests.",
  delegatedModel: "claude-3-5-sonnet-20241022",
  reasoningEffort: "medium",
  agentsStates: {},
};

export const Initiated: Story = () => (
  <div className="p-4 max-w-lg">
    <DelegationItemCard
      delegation={{ ...baseDelegation, status: "initiated" }}
    />
  </div>
);

export const Running: Story = () => (
  <div className="p-4 max-w-lg">
    <DelegationItemCard
      delegation={{
        ...baseDelegation,
        status: "running",
        agentsStates: {
          "thread-a": "running",
          "thread-b": "initiated",
        },
      }}
    />
  </div>
);

export const Completed: Story = () => (
  <div className="p-4 max-w-lg">
    <DelegationItemCard
      delegation={{
        ...baseDelegation,
        status: "completed",
        agentsStates: {
          "thread-a": "completed",
          "thread-b": "completed",
        },
      }}
    />
  </div>
);

export const Failed: Story = () => (
  <div className="p-4 max-w-lg">
    <DelegationItemCard
      delegation={{
        ...baseDelegation,
        status: "failed",
        agentsStates: {
          "thread-a": "failed",
          "thread-b": "completed",
        },
      }}
    />
  </div>
);
