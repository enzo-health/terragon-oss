"use client";

import React, { memo } from "react";
import { useState } from "react";
import type { ArtifactDescriptor } from "@terragon/shared/db/artifact-descriptors";
import { MessagePart } from "./message-part";
import { ImageLightbox } from "@/components/shared/image-lightbox";
import { MessagePartRenderProps, PartGroup } from "./chat-message.types";

type ImageGroupProps = {
  group: PartGroup;
  messagePartProps: MessagePartRenderProps;
  isLatestMessage?: boolean;
  artifactDescriptors: ArtifactDescriptor[];
  onOpenArtifact: (artifactId: string) => void;
};

export const ImageGroup = memo(function ImageGroup({
  group,
  messagePartProps,
  isLatestMessage = false,
  artifactDescriptors,
  onOpenArtifact,
}: ImageGroupProps) {
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null);

  const imageUrls = group.parts
    .filter(
      (part): part is { type: "image"; image_url: string } =>
        part.type === "image",
    )
    .map((part) => part.image_url);

  const numParts = group.parts.length;
  return (
    <>
      <div className="flex gap-2 flex-wrap">
        {group.parts.map((part, partIndex) => {
          return (
            <MessagePart
              key={partIndex}
              part={part}
              onClick={() => setExpandedIndex(partIndex)}
              isLatest={isLatestMessage && partIndex === numParts - 1}
              {...messagePartProps}
              artifactDescriptors={artifactDescriptors}
              onOpenArtifact={onOpenArtifact}
            />
          );
        })}
      </div>
      {expandedIndex !== null && imageUrls[expandedIndex] && (
        <ImageLightbox
          imageUrl={imageUrls[expandedIndex]}
          isOpen={true}
          onClose={() => setExpandedIndex(null)}
          images={imageUrls}
          currentIndex={expandedIndex}
          onIndexChange={setExpandedIndex}
        />
      )}
    </>
  );
}, areImageGroupPropsEqual);

function areImageGroupPropsEqual(
  prev: ImageGroupProps,
  next: ImageGroupProps,
): boolean {
  if (prev.group.type !== next.group.type) return false;
  if (prev.group.parts.length !== next.group.parts.length) return false;
  for (let i = 0; i < prev.group.parts.length; i++) {
    if (prev.group.parts[i] !== next.group.parts[i]) return false;
  }
  return (
    prev.messagePartProps === next.messagePartProps &&
    prev.isLatestMessage === next.isLatestMessage &&
    prev.artifactDescriptors === next.artifactDescriptors &&
    prev.onOpenArtifact === next.onOpenArtifact
  );
}
