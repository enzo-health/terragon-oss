import type { Story, StoryDefault } from "@ladle/react";
import { ImagePartView } from "./image-part-view";
import type { DBImagePart } from "@terragon/shared";

export default {
  title: "Chat/ImagePartView",
} satisfies StoryDefault;

export const FromUri: Story = () => {
  const part: DBImagePart = {
    type: "image",
    mime_type: "image/png",
    image_url: "https://picsum.photos/400/300",
  };
  return (
    <div className="p-4">
      <ImagePartView part={part} />
    </div>
  );
};
