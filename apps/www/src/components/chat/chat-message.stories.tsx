import type { Story, StoryDefault } from "@ladle/react";
import { WorkingMessage } from "./chat-messages";
import { BootChecklist } from "./boot-checklist";
import { createInitialThreadMetaSnapshot } from "./thread-view-model/snapshot-adapter";

export default {
  title: "Chat/Chat Message",
} satisfies StoryDefault;

const defaultProps = {
  agent: "claudeCode" as const,
  reattemptQueueAt: null,
  metaSnapshot: createInitialThreadMetaSnapshot(),
};

// ----- BootChecklist stories -----

export const BootChecklist_FirstStep: Story = () => (
  <div className="p-4 max-w-sm">
    <p className="text-xs text-muted-foreground mb-2">
      First step — provisioning in-progress, no meta events yet
    </p>
    <BootChecklist
      currentSubstatus="provisioning"
      metaSnapshot={defaultProps.metaSnapshot}
    />
  </div>
);

export const BootChecklist_MidBoot: Story = () => (
  <div className="p-4 max-w-sm">
    <p className="text-xs text-muted-foreground mb-2">
      Mid-boot — cloning-repo in-progress (fallback from currentSubstatus)
    </p>
    <BootChecklist
      currentSubstatus="cloning-repo"
      metaSnapshot={defaultProps.metaSnapshot}
    />
  </div>
);

export const BootChecklist_InstallingAgent: Story = () => (
  <div className="p-4 max-w-sm">
    <p className="text-xs text-muted-foreground mb-2">
      Installing agent — in-progress (no install progress events yet)
    </p>
    <BootChecklist
      currentSubstatus="installing-agent"
      metaSnapshot={defaultProps.metaSnapshot}
    />
  </div>
);

export const BootChecklist_RunningSetupScript: Story = () => (
  <div className="p-4 max-w-sm">
    <p className="text-xs text-muted-foreground mb-2">Running setup script</p>
    <BootChecklist
      currentSubstatus="running-setup-script"
      metaSnapshot={defaultProps.metaSnapshot}
    />
  </div>
);

export const BootChecklist_BootingDone: Story = () => (
  <div className="p-4 max-w-sm">
    <p className="text-xs text-muted-foreground mb-2">
      Booting done — waiting for assistant to start
    </p>
    <BootChecklist
      currentSubstatus="booting-done"
      metaSnapshot={defaultProps.metaSnapshot}
    />
  </div>
);

export const BootChecklist_NoSubstatus: Story = () => (
  <div className="p-4 max-w-sm">
    <p className="text-xs text-muted-foreground mb-2">
      No substatus yet — first step shown as in-progress
    </p>
    <BootChecklist
      currentSubstatus={null}
      metaSnapshot={defaultProps.metaSnapshot}
    />
  </div>
);

// ----- WorkingMessage stories (non-booting) -----

export const WorkingMessage_: Story = () => {
  return (
    <div className="space-y-4">
      <WorkingMessage status="working" {...defaultProps} />
      <WorkingMessage status="checkpointing" {...defaultProps} />
      <WorkingMessage status="complete" {...defaultProps} />
      <WorkingMessage status="stopped" {...defaultProps} />
      <WorkingMessage
        status="queued-agent-rate-limit"
        {...defaultProps}
        reattemptQueueAt={new Date(Date.now() + 1000 * 60 * 60 * 2)}
      />
      <WorkingMessage
        status="queued-agent-rate-limit"
        {...defaultProps}
        reattemptQueueAt={new Date(Date.now() + 1000 * 60 * 45)}
      />
      <WorkingMessage
        status="queued-agent-rate-limit"
        {...defaultProps}
        reattemptQueueAt={new Date(Date.now() + 1000 * 60)}
      />
      <WorkingMessage
        status="queued-agent-rate-limit"
        {...defaultProps}
        agent="codex"
      />
      <WorkingMessage
        status="queued-sandbox-creation-rate-limit"
        {...defaultProps}
      />
      <WorkingMessage status="queued-tasks-concurrency" {...defaultProps} />
    </div>
  );
};
