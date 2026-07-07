"use client";

import { FileText } from "lucide-react";
import {
  Attachment,
  AttachmentContent,
  AttachmentDescription,
  AttachmentIcon,
  AttachmentMedia,
  AttachmentName,
} from "@/components/ai/attachment";
import { ImagePart } from "../../image-part";
import type { Leaf, LeafItem } from "../leaf-props";

function imageSrc(item: LeafItem<"image">): string | null {
  if (item.url) return item.url;
  if (item.data) {
    return `data:${item.mimeType ?? "image/png"};base64,${item.data}`;
  }
  return null;
}

export const ImageLeaf: Leaf<"image"> = ({ item }) => {
  const src = imageSrc(item);
  if (!src) return null;
  return <ImagePart imageUrl={src} />;
};

function formatSize(size: number | null): string | null {
  if (size === null) return null;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

export const AttachmentLeaf: Leaf<"attachment"> = ({ item }) => {
  const name = item.name ?? "Attachment";
  const description = formatSize(item.size) ?? item.mimeType ?? "";
  const body = (
    <>
      <AttachmentMedia>
        <AttachmentIcon>
          <FileText />
        </AttachmentIcon>
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentName>{name}</AttachmentName>
        {description ? (
          <AttachmentDescription>{description}</AttachmentDescription>
        ) : null}
      </AttachmentContent>
    </>
  );

  return item.url ? (
    <Attachment render={<a href={item.url} target="_blank" rel="noreferrer" />}>
      {body}
    </Attachment>
  ) : (
    <Attachment>{body}</Attachment>
  );
};
