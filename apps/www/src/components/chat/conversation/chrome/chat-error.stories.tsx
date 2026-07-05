import type { Story, StoryDefault } from "@ladle/react";
import { ChatError } from "./chat-error";

const mockHandleRetry = async () => {
  console.log("Retry clicked");
};

export const MissingClaudeCredentials: Story = () => {
  return (
    <div className="p-4 max-w-2xl">
      <ChatError
        errorType="missing-claude-credentials"
        errorInfo=""
        status="complete"
        handleRetry={mockHandleRetry}
        isReadOnly={false}
      />
    </div>
  );
};

export const RequestTimeout: Story = () => {
  return (
    <div className="p-4 max-w-2xl">
      <ChatError
        status="complete"
        errorType="request-timeout"
        errorInfo=""
        handleRetry={mockHandleRetry}
        isReadOnly={false}
      />
    </div>
  );
};

export const UnknownError: Story = () => {
  return (
    <div className="p-4 max-w-2xl">
      <ChatError
        status="complete"
        errorType="unknown-error"
        errorInfo="An unexpected error occurred while processing your request."
        handleRetry={mockHandleRetry}
        isReadOnly={false}
      />
    </div>
  );
};

export const SandboxNotFound: Story = () => {
  return (
    <div className="p-4 max-w-2xl">
      <ChatError
        status="complete"
        errorType="sandbox-not-found"
        errorInfo=""
        handleRetry={mockHandleRetry}
        isReadOnly={false}
      />
    </div>
  );
};

export const SandboxCreationFailed: Story = () => {
  return (
    <div className="p-4 max-w-2xl">
      <ChatError
        status="complete"
        errorType="sandbox-creation-failed"
        errorInfo="Failed to create sandbox: Insufficient resources available. Please try again later."
        handleRetry={mockHandleRetry}
        isReadOnly={false}
      />
    </div>
  );
};

export const SandboxResumeFailed: Story = () => {
  return (
    <div className="p-4 max-w-2xl">
      <ChatError
        status="complete"
        errorType="sandbox-resume-failed"
        errorInfo="Failed to resume sandbox: Connection timeout after 30 seconds."
        handleRetry={mockHandleRetry}
        isReadOnly={false}
      />
    </div>
  );
};

export const AgentNotResponding: Story = () => {
  return (
    <div className="p-4 max-w-2xl">
      <ChatError
        status="complete"
        errorType="agent-not-responding"
        errorInfo="The agent has not responded for 60 seconds. This may be due to network issues or high system load."
        handleRetry={mockHandleRetry}
        isReadOnly={false}
      />
    </div>
  );
};

export const AgentGenericError: Story = () => {
  return (
    <div className="p-4 max-w-2xl">
      <ChatError
        status="complete"
        errorType="agent-generic-error"
        errorInfo="Agent process exited with code 1: EACCES: permission denied, access '/root/.npm'"
        handleRetry={mockHandleRetry}
        isReadOnly={false}
      />
    </div>
  );
};

export const GitCheckpointPushFailed: Story = () => {
  return (
    <div className="p-4 max-w-2xl">
      <ChatError
        status="complete"
        errorType="git-checkpoint-push-failed"
        errorInfo={`To github.com:terragon-labs/terragon.git
! [rejected]        terragon/fca1cf -> terragon/fca1cf (non-fast-forward)
error: failed to push some refs to 'github.com:terragon-labs/terragon.git'
hint: Updates were rejected because the tip of your current branch is behind
hint: its remote counterpart. Integrate the remote changes (e.g.
hint: 'git pull ...') before pushing again.
hint: See the 'Note about fast-forwards' in 'git push --help' for details.`}
        handleRetry={mockHandleRetry}
        isReadOnly={false}
      />
    </div>
  );
};

export const GitCheckpointDiffFailed: Story = () => {
  return (
    <div className="p-4 max-w-2xl">
      <ChatError
        status="complete"
        errorType="git-checkpoint-diff-failed"
        errorInfo="fatal: ambiguous argument 'HEAD~1': unknown revision or path not in the working tree."
        handleRetry={mockHandleRetry}
        isReadOnly={false}
      />
    </div>
  );
};

export const PromptTooLong: Story = () => {
  return (
    <div className="p-4 max-w-2xl">
      <ChatError
        status="complete"
        errorType="prompt-too-long"
        errorInfo=""
        handleRetry={mockHandleRetry}
        isReadOnly={false}
      />
    </div>
  );
};

export const BackwardsCompatibilityError: Story = () => {
  return (
    <div className="p-4 max-w-2xl">
      <ChatError
        status="complete"
        errorType="Something went wrong with the operation"
        errorInfo="Additional details: The server returned an invalid response."
        handleRetry={mockHandleRetry}
        isReadOnly={false}
      />
    </div>
  );
};

export const EmptyError: Story = () => {
  return (
    <div className="p-4 max-w-2xl">
      <ChatError
        status="complete"
        errorType=""
        errorInfo=""
        handleRetry={mockHandleRetry}
        isReadOnly={false}
      />
    </div>
  );
};

export const LongErrorMessage: Story = () => {
  const longError = `Error: Failed to execute operation
Stack trace:
  at processRequest (index.js:123:45)
  at async handleUserInput (handler.js:67:12)
  at async main (app.js:34:8)
  
Additional context: The operation failed due to insufficient permissions. Please check your access rights and try again.`;

  return (
    <div className="p-4 max-w-2xl">
      <ChatError
        status="complete"
        errorType={longError}
        errorInfo="This error occurred during batch processing of multiple files."
        handleRetry={mockHandleRetry}
        isReadOnly={false}
      />
    </div>
  );
};

export const GitPushFailedMobileOverflow: Story = () => {
  const veryLongErrorMessage = `To github.com:terragon-labs/terragon.git
! [rejected]        terragon/very-long-branch-name-that-could-cause-overflow-issues-on-mobile-devices -> terragon/very-long-branch-name-that-could-cause-overflow-issues-on-mobile-devices (non-fast-forward)
error: failed to push some refs to 'github.com:terragon-labs/terragon.git'
hint: Updates were rejected because the tip of your current branch is behind its remote counterpart. This is a very long error message that contains detailed information about what went wrong and how to fix it. The message continues with more details that could potentially cause overflow issues on mobile devices when the refresh icon is displayed.
hint: Integrate the remote changes (e.g. 'git pull ...') before pushing again.
hint: See the 'Note about fast-forwards' in 'git push --help' for details.
Additional error details: Authentication failed after multiple attempts. Please check your credentials and ensure you have the necessary permissions to push to this repository.`;

  return (
    <div className="p-4 max-w-sm">
      {" "}
      {/* Using max-w-sm to simulate mobile viewport */}
      <ChatError
        status="complete"
        errorType="git-checkpoint-push-failed"
        errorInfo={veryLongErrorMessage}
        handleRetry={mockHandleRetry}
        isReadOnly={false}
      />
    </div>
  );
};

export default {
  title: "Chat/Chat Error",
} satisfies StoryDefault;
