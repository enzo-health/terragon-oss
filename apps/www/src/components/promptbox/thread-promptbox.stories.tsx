import type { StoryDefault, Story } from "@ladle/react";
import { ThreadPromptBox } from "./thread-promptbox";
import { useState } from "react";
import { DBUserMessage } from "@leo/shared";
import { AGENT_VERSION } from "@leo/agent/versions";

export default {
  title: "PromptBox/Thread",
} satisfies StoryDefault;

export const WithQueuedMessages: Story = () => {
  const [queuedMessages, setQueuedMessages] = useState<DBUserMessage[]>([
    {
      type: "user",
      model: "sonnet",
      parts: [
        {
          type: "text",
          text: "Can you help me refactor the authentication system?",
        },
      ],
    },
    {
      type: "user",
      model: "sonnet",
      parts: [
        {
          type: "text",
          text: [
            "1. Add a new feature",
            "2. Add a new feature",
            "3. Add a new feature",
            "4. Add a new feature",
            "5. Add a new feature",
          ].join("\n"),
        },
      ],
    },
  ]);

  return (
    <div className="sticky bottom-0 z-10 bg-background chat-prompt-box px-6 max-w-[800px] w-full mx-auto">
      <ThreadPromptBox
        threadId="thread-1"
        threadChatId="thread-chat-1"
        sandboxId="sandbox-123"
        status="working"
        repoFullName="user/repo"
        branchName="main"
        prStatus="open"
        prChecksStatus={null}
        githubPRNumber={123}
        agent="claudeCode"
        agentVersion={AGENT_VERSION}
        lastUsedModel="sonnet"
        handleStop={() => Promise.resolve()}
        handleSubmit={() => Promise.resolve()}
        queuedMessages={queuedMessages}
        handleQueueMessage={() => Promise.resolve()}
        onUpdateQueuedMessage={setQueuedMessages}
      />
    </div>
  );
};

const LOREM_IPSUM =
  "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.";

export const WithLongQueuedMessages: Story = () => {
  const [queuedMessages, setQueuedMessages] = useState<DBUserMessage[]>([
    {
      type: "user",
      model: "sonnet",
      parts: [
        { type: "text", text: LOREM_IPSUM },
        { type: "text", text: LOREM_IPSUM },
        { type: "text", text: LOREM_IPSUM },
        { type: "text", text: LOREM_IPSUM },
        { type: "text", text: LOREM_IPSUM },
        { type: "text", text: LOREM_IPSUM },
        { type: "text", text: LOREM_IPSUM },
      ],
    },
  ]);

  return (
    <div className="sticky bottom-0 z-10 bg-background chat-prompt-box px-6 max-w-[800px] w-full mx-auto">
      <ThreadPromptBox
        threadId="thread-1"
        threadChatId="thread-chat-1"
        sandboxId="sandbox-123"
        status="working"
        repoFullName="user/repo"
        branchName="main"
        prStatus={null}
        prChecksStatus={null}
        githubPRNumber={null}
        agent="claudeCode"
        agentVersion={AGENT_VERSION}
        lastUsedModel="sonnet"
        handleStop={() => Promise.resolve()}
        handleSubmit={() => Promise.resolve()}
        queuedMessages={queuedMessages}
        handleQueueMessage={() => Promise.resolve()}
        onUpdateQueuedMessage={setQueuedMessages}
      />
    </div>
  );
};
