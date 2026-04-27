"use client";

import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogClose,
  DialogPortal,
  DialogOverlay,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { X } from "lucide-react";
import { VisuallyHidden } from "@radix-ui/react-visually-hidden";
import { useEffect, useCallback } from "react";
import { Attachment } from "@/lib/attachment-types";

export function ImageLightboxForAttachedImage({
  image,
  images,
  onClose,
  onImageChange,
}: {
  image: Attachment | null;
  images?: Attachment[];
  onClose: () => void;
  onImageChange?: (imageId: string) => void;
}) {
  const currentIndex = images?.findIndex((img) => img.id === image?.id) ?? -1;

  if (!image) {
    return null;
  }
  return (
    <ImageLightbox
      imageUrl={image.uploadStatus === "completed" ? image.r2Url : image.base64}
      isOpen={!!image}
      onClose={onClose}
      images={images?.map((img) =>
        img.uploadStatus === "completed" ? img.r2Url : img.base64,
      )}
      currentIndex={currentIndex}
      onIndexChange={(index) => {
        if (images && onImageChange && images[index]) {
          onImageChange(images[index].id);
        }
      }}
    />
  );
}

export function ImageLightbox({
  imageUrl,
  isOpen,
  onClose,
  images,
  currentIndex,
  onIndexChange,
}: {
  imageUrl: string;
  isOpen: boolean;
  onClose: () => void;
  images?: string[];
  currentIndex?: number;
  onIndexChange?: (index: number) => void;
}) {
  const hasMultipleImages =
    images && images.length > 1 && currentIndex !== undefined;

  const handlePrevious = useCallback(() => {
    if (hasMultipleImages && onIndexChange) {
      const newIndex =
        currentIndex === 0 ? images.length - 1 : currentIndex - 1;
      onIndexChange(newIndex);
    }
  }, [hasMultipleImages, currentIndex, images?.length, onIndexChange]);

  const handleNext = useCallback(() => {
    if (hasMultipleImages && onIndexChange) {
      const newIndex =
        currentIndex === images.length - 1 ? 0 : currentIndex + 1;
      onIndexChange(newIndex);
    }
  }, [hasMultipleImages, currentIndex, images?.length, onIndexChange]);

  useEffect(() => {
    if (!isOpen || !hasMultipleImages) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft" || e.key === "<") {
        e.preventDefault();
        handlePrevious();
      } else if (e.key === "ArrowRight" || e.key === ">") {
        e.preventDefault();
        handleNext();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, hasMultipleImages, handlePrevious, handleNext]);

  const displayUrl =
    hasMultipleImages && images ? images[currentIndex] : imageUrl;

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogPortal>
        <DialogOverlay />
        <DialogContent
          className="!max-w-[80vw] !max-h-[80vh] p-0 overflow-hidden bg-transparent border-none shadow-none"
          hideCloseButton
        >
          <VisuallyHidden>
            <DialogTitle>Image</DialogTitle>
          </VisuallyHidden>
          <div className="relative flex items-center justify-center">
            <img
              src={displayUrl}
              alt="Expanded image"
              width={800}
              height={600}
              loading="lazy"
              className="max-w-full max-h-[70vh] object-contain rounded bg-background"
            />
          </div>
        </DialogContent>
        <DialogClose
          className="fixed top-4 right-4 text-white rounded-full p-3 transition-colors z-[60] cursor-pointer"
          asChild
        >
          <Button
            variant="ghost"
            size="icon"
            className="text-white hover:text-white hover:bg-transparent cursor-pointer"
          >
            <X className="size-6" />
          </Button>
        </DialogClose>
      </DialogPortal>
    </Dialog>
  );
}
