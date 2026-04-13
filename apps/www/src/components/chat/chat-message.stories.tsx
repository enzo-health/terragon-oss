import type { Story, StoryDefault } from "@ladle/react";
import { ChatMessage } from "./chat-message";
import { WorkingMessage } from "./chat-messages";
import { UIMessage } from "@terragon/shared";

export default {
  title: "Chat/Chat Message",
} satisfies StoryDefault;

export const UserMessage: Story = () => {
  const message: UIMessage = {
    id: "user-0",
    role: "user",
    parts: [
      {
        type: "text",
        text: [
          "Can you help me create a React component?",
          "",
          "1. Create a new component",
          "2. Add tests",
          "3. Style the component",
          "4. Add to the project",
          "5. Add to the project",
          "6. Add to the project",
          "7. Add to the project",
          "8. Add to the project",
          "9. Add to the project",
          "10. Add to the project",
          "11. Add to the project",
          "12. Add to the project",
          "13. Add to the project",
          "14. Add to the project",
          "15. Add to the project",
        ].join("\n"),
      },
    ],
  };

  return (
    <div className="p-4 max-w-4xl">
      <ChatMessage message={message} />
    </div>
  );
};

export const SystemMessageRetryGitCommitAndPush: Story = () => {
  const message: UIMessage = {
    id: "system-1",
    role: "system",
    message_type: "retry-git-commit-and-push",
    parts: [
      {
        text: "Failed to commit and push changes with the following error: ThreadError: Thread error: git-checkpoint-push-failed: Command failed with exit code 1\n\nstdout:\n (empty)\nstderr:\n [STARTED] Backing up original state...\n[COMPLETED] Backed up original state in git stash (b3f5b1b)\n[STARTED] Running tasks for staged files...\n[STARTED] .lintstagedrc.json — 8 files\n[STARTED] *.{js,jsx,ts,tsx} — 7 files\n[STARTED] *.{ts,tsx} — 7 files\n[STARTED] *.{json,md,css} — 0 files\n[SKIPPED] *.{json,md,css} — no files\n[STARTED] eslint --fix\n[STARTED] bash -c 'tsc --noEmit'\n[FAILED] bash -c 'tsc --noEmit' [FAILED]\n[FAILED] bash -c 'tsc --noEmit' [FAILED]\n[COMPLETED] Running tasks for staged files...\n[STARTED] Applying modifications from tasks...\n[SKIPPED] Skipped because of errors from tasks.\n[STARTED] Reverting to original state because of errors...\n[FAILED] eslint --fix [SIGKILL]\n[FAILED] eslint --fix [SIGKILL]\n[FAILED] fatal: Out of memory, malloc failed (tried to allocate 18446744073296040485 bytes)\n[FAILED] error: could not generate diff b3f5b1b14a7109b6ecbfa56dd2bf85f64eb8e9c5^!.\n[STARTED] Cleaning up temporary files...\n\n[SKIPPED]   ✖ lint-staged failed due to a git error.\n\n  ✖ lint-staged failed due to a git error.\nAny lost modifications can be restored from a git stash:\n\n  > git stash list\n  stash@{0}: automatic lint-staged backup\n  > git stash apply --index stash@{0}\n\n\n✖ bash -c 'tsc --noEmit':\nsrc/components/StateManagementExample.tsx(41,46): error TS2322: Type '{ id: string; componentId: string; position: { x: number; y: number; }; size: { width: number; height: number; }; props: { text: string; }; }' is not assignable to type 'CanvasElement'.\n  Types of property 'id' are incompatible.\n    Type 'string' is not assignable to type 'ElementId'.\n      Type 'string' is not assignable to type '{ __brand: \"ElementId\"; }'.\nsrc/components/app/IntegratedAppEnhanced.tsx(117,7): error TS2353: Object literal may only specify known properties, and 'includePackageJson'",
        type: "text",
      },
    ],
  };
  return (
    <div className="p-4 max-w-4xl">
      <ChatMessage message={message} />
    </div>
  );
};

export const SystemMessageClearContext: Story = () => {
  const message: UIMessage = {
    id: "system-2",
    role: "system",
    message_type: "clear-context",
    parts: [],
  };
  return (
    <div className="p-4 max-w-4xl">
      <ChatMessage message={message} />
    </div>
  );
};

const defaultProps = {
  agent: "claudeCode" as const,
  reattemptQueueAt: null,
};

export const WorkingMessage_: Story = () => {
  return (
    <div className="space-y-4">
      <WorkingMessage status="booting" {...defaultProps} />
      <WorkingMessage
        status="booting"
        bootingSubstatus="provisioning"
        {...defaultProps}
      />
      <WorkingMessage
        status="booting"
        bootingSubstatus="cloning-repo"
        {...defaultProps}
      />
      <WorkingMessage
        status="booting"
        bootingSubstatus="installing-agent"
        {...defaultProps}
      />
      <WorkingMessage
        status="booting"
        bootingSubstatus="running-setup-script"
        {...defaultProps}
      />
      <WorkingMessage
        status="booting"
        bootingSubstatus="booting-done"
        {...defaultProps}
      />
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
