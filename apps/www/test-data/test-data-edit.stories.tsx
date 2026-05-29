import type { Story, StoryDefault } from "@ladle/react";
import { ChatMessage } from "@/components/chat/chat-message";
import { toUIMessages } from "@/components/chat/toUIMessages";
import claudeJson from "./claude-json-edit-test.json";
import { toDBMessage } from "@/agent/msg/toDBMessage";

export const Edit: Story = () => {
  const dbMessages = claudeJson
    .map((x: any) => {
      return toDBMessage(x);
    })
    .flat();
  const messages = toUIMessages({ dbMessages, agent: "claudeCode" });
  return (
    <div>
      {messages.map((message) => {
        return <ChatMessage key={message.id} message={message} />;
      })}
    </div>
  );
};

export default {
  title: "Test Data",
} satisfies StoryDefault;
