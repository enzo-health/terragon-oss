"use client";

import React, { useState } from "react";
import { ImageLightbox } from "@/components/shared/image-lightbox";
import type { DBImagePart } from "@terragon/shared";

export interface ImagePartViewProps {
  part: DBImagePart;
}

export function ImagePartView({ part }: ImagePartViewProps) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const imageUrl = part.image_url;

  return (
    <>
      <div className="w-fit">
        <img
          src={imageUrl}
          alt="Image attachment"
          className="max-w-[512px] max-h-[512px] object-contain rounded cursor-pointer"
          loading="lazy"
          decoding="async"
          onClick={() => setLightboxOpen(true)}
        />
      </div>
      {lightboxOpen && (
        <ImageLightbox
          imageUrl={imageUrl}
          isOpen={lightboxOpen}
          onClose={() => setLightboxOpen(false)}
          images={[imageUrl]}
          currentIndex={0}
          onIndexChange={() => {}}
        />
      )}
    </>
  );
}
