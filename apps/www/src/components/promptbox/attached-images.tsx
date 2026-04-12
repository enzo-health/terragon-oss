import React, { useState } from "react";
import { X, Loader2 } from "lucide-react";
import { ImageLightboxForAttachedImage } from "@/components/shared/image-lightbox";
import { useTouchDevice } from "@/hooks/useTouchDevice";
import { cn } from "@/lib/utils";
import { Attachment } from "@/lib/attachment-types";

interface AttachedImagesProps {
  attachedImages: Attachment[];
  onRemoveImage: (id: string) => void;
}

export function AttachedImages({
  attachedImages,
  onRemoveImage,
}: AttachedImagesProps) {
  const [expandedImageId, setExpandedImageId] = useState<string | null>(null);
  const isTouchDevice = useTouchDevice();

  if (attachedImages.length === 0) {
    return null;
  }

  return (
    <>
      <div className="flex flex-wrap gap-2 px-4">
        {attachedImages.map((image) => (
          <div key={image.id} className="relative group">
            <button
              onClick={() => setExpandedImageId(image.id)}
              className="relative block cursor-pointer"
              type="button"
            >
              <img
                src={
                  image.uploadStatus === "completed"
                    ? image.r2Url
                    : image.base64
                }
                alt="Attached image"
                className={cn(
                  "max-w-20 max-h-20 object-cover rounded border transition-opacity",
                  image.uploadStatus === "pending" ||
                    image.uploadStatus === "uploading"
                    ? "opacity-50"
                    : "",
                  image.uploadStatus === "failed"
                    ? "opacity-70 border-destructive border-2"
                    : "",
                )}
              />
              {/* Upload status overlay */}
              {image.uploadStatus === "pending" ||
              image.uploadStatus === "uploading" ? (
                <div className="absolute inset-0 flex items-center justify-center bg-foreground/20 rounded">
                  <Loader2 className="size-4 text-white animate-spin" />
                </div>
              ) : null}
            </button>
            <button
              onClick={() => onRemoveImage(image.id)}
              className={cn(
                "absolute -top-2 -right-2 bg-accent text-accent-foreground rounded-full transition-opacity z-10",
                isTouchDevice
                  ? "opacity-100 p-1.5"
                  : "opacity-0 group-hover:opacity-100 p-1",
                image.uploadStatus === "failed"
                  ? "bg-destructive text-destructive-foreground !opacity-100"
                  : "",
              )}
              type="button"
              aria-label="Remove image"
            >
              <X className={cn(isTouchDevice ? "size-4" : "size-3")} />
            </button>
            {/* Error tooltip */}
            {image.uploadStatus === "failed" && (
              <div className="absolute bottom-full mb-1 px-2 py-1 -left-2 bg-destructive text-destructive-foreground text-xs rounded shadow-lg whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                Failed to upload
              </div>
            )}
          </div>
        ))}
      </div>
      <ImageLightboxForAttachedImage
        image={attachedImages.find((img) => img.id === expandedImageId) || null}
        images={attachedImages}
        onClose={() => setExpandedImageId(null)}
        onImageChange={(imageId) => setExpandedImageId(imageId)}
      />
    </>
  );
}
