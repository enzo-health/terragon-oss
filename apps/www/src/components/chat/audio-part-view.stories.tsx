import type { Story, StoryDefault } from "@ladle/react";
import { AudioPartView } from "./audio-part-view";
import type { DBAudioPart } from "@terragon/shared";

export default {
  title: "Chat/AudioPartView",
} satisfies StoryDefault;

export const WithUri: Story = () => {
  const part: DBAudioPart = {
    type: "audio",
    mimeType: "audio/mpeg",
    uri: "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3",
  };
  return (
    <div className="p-4 max-w-md">
      <AudioPartView part={part} />
    </div>
  );
};

export const NoSource: Story = () => {
  const part: DBAudioPart = {
    type: "audio",
    mimeType: "audio/mpeg",
  };
  return (
    <div className="p-4 max-w-md">
      <AudioPartView part={part} />
    </div>
  );
};
