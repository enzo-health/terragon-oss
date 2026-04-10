import type { StoryDefault, Story } from "@ladle/react";
import { GenericPromptBox } from "./generic-promptbox";
import { DBUserMessage } from "@leo/shared";
import { useState } from "react";
import { action } from "@ladle/react";

export default {
  title: "PromptBox/Edit Message",
} satisfies StoryDefault;

const sampleMessage: DBUserMessage = {
  type: "user",
  model: "sonnet",
  parts: [
    {
      type: "rich-text",
      nodes: [
        {
          type: "text",
          text: "Can you help me implement a ",
        },
        {
          type: "mention",
          text: "Button",
        },
        {
          type: "text",
          text: " component that supports dark mode?",
        },
      ],
    },
  ],
  timestamp: new Date().toISOString(),
};

const messageWithImage: DBUserMessage = {
  type: "user",
  model: "opus",
  parts: [
    {
      type: "rich-text",
      nodes: [
        {
          type: "text",
          text: "Here's a screenshot of the design I want to implement:",
        },
      ],
    },
    {
      type: "image",
      mime_type: "image/png",
      image_url:
        "https://cdn.terragonlabs.com/CleanShot%202025-06-06%20at%2014.34.40@2x-sZjx.png",
    },
  ],
  timestamp: new Date().toISOString(),
};

export const Basic: Story = () => {
  const [message, setMessage] = useState(sampleMessage);
  const handleSubmit = async ({
    userMessage,
  }: {
    userMessage: DBUserMessage;
  }) => {
    setMessage(userMessage);
    action("Message updated")(userMessage);
  };
  return (
    <div className="p-4 space-y-4">
      <GenericPromptBox
        message={message}
        repoFullName="leo-labs/leo"
        branchName="main"
        onSubmit={handleSubmit}
        hideSubmitButton={false}
        autoFocus={true}
        placeholder="Your message here... Use @ to mention files"
        forcedAgent={null}
        forcedAgentVersion={null}
      />
      <div className="border rounded-lg p-4 bg-muted/50">
        <h3 className="text-sm font-semibold mb-2">DB Message:</h3>
        <pre className="text-xs whitespace-pre-wrap">
          {JSON.stringify(message, null, 2)}
        </pre>
      </div>
    </div>
  );
};

export const WithImage: Story = () => {
  const [message, setMessage] = useState(messageWithImage);
  const handleSubmit = async ({
    userMessage,
  }: {
    userMessage: DBUserMessage;
  }) => {
    setMessage(userMessage);
    action("Message with image updated")(userMessage);
  };

  return (
    <div className="p-4 space-y-4">
      <div className="text-sm text-muted-foreground">
        Note: This message contains an existing image that will be displayed in
        the attached images section.
      </div>
      <GenericPromptBox
        message={message}
        repoFullName="leo-labs/leo"
        branchName="main"
        onSubmit={handleSubmit}
        hideSubmitButton={false}
        autoFocus={true}
        placeholder="Your message here... Use @ to mention files"
        forcedAgent={null}
        forcedAgentVersion={null}
      />
    </div>
  );
};
