import React, { useState } from "react";
import { X, Loader2, FileText } from "lucide-react";
import { ImageLightboxForAttachedImage } from "@/components/shared/image-lightbox";
import { useTouchDevice } from "@/hooks/useTouchDevice";
import { cn } from "@/lib/utils";
import { Attachment } from "@/lib/attachment-types";

interface AttachedFilesProps {
  attachedFiles: Attachment[];
  onRemoveFile: (id: string) => void;
}

export function AttachedFiles({
  attachedFiles,
  onRemoveFile,
}: AttachedFilesProps) {
  const [expandedImageId, setExpandedImageId] = useState<string | null>(null);
  const isTouchDevice = useTouchDevice();

  if (attachedFiles.length === 0) {
    return null;
  }

  // Separate images and PDFs for the lightbox
  const images = attachedFiles.filter(
    (file) => file.fileType === "image",
  ) as Attachment[];

  return (
    <>
      <div className="flex flex-wrap gap-2 px-4">
        {attachedFiles.map((file) => (
          <div key={file.id} className="relative group">
            {file.fileType === "image" ? (
              <button
                onClick={() => setExpandedImageId(file.id)}
                className="relative block cursor-pointer"
                type="button"
              >
                <img
                  src={
                    file.uploadStatus === "completed" ? file.r2Url : file.base64
                  }
                  alt="Attached image"
                  className={cn(
                    "max-w-20 max-h-20 object-cover rounded border transition-opacity",
                    file.uploadStatus === "pending" ||
                      file.uploadStatus === "uploading"
                      ? "opacity-50"
                      : "",
                    file.uploadStatus === "failed"
                      ? "opacity-70 border-destructive border-2"
                      : "",
                  )}
                />
                {/* Upload status overlay */}
                {file.uploadStatus === "pending" ||
                file.uploadStatus === "uploading" ? (
                  <div className="absolute inset-0 flex items-center justify-center bg-foreground/20 rounded">
                    <Loader2 className="size-4 text-white animate-spin" />
                  </div>
                ) : null}
              </button>
            ) : (
              <div
                className={cn(
                  "relative flex flex-col items-center justify-center w-20 h-20 rounded border bg-muted/50 transition-opacity",
                  file.uploadStatus === "pending" ||
                    file.uploadStatus === "uploading"
                    ? "opacity-50"
                    : "",
                  file.uploadStatus === "failed"
                    ? "opacity-70 border-destructive border-2"
                    : "",
                )}
              >
                <FileText className="size-8 text-muted-foreground" />
                <span className="text-xs text-muted-foreground mt-1 px-1 truncate w-full text-center">
                  {file.fileName || "PDF"}
                </span>
                {/* Upload status overlay */}
                {file.uploadStatus === "pending" ||
                file.uploadStatus === "uploading" ? (
                  <div className="absolute inset-0 flex items-center justify-center bg-foreground/20 rounded">
                    <Loader2 className="size-4 text-white animate-spin" />
                  </div>
                ) : null}
              </div>
            )}
            <button
              onClick={() => onRemoveFile(file.id)}
              className={cn(
                "absolute -top-2 -right-2 bg-accent text-accent-foreground rounded-full transition-opacity z-10",
                isTouchDevice
                  ? "opacity-100 p-1.5"
                  : "opacity-0 group-hover:opacity-100 p-1",
                file.uploadStatus === "failed"
                  ? "bg-destructive text-destructive-foreground !opacity-100"
                  : "",
              )}
              type="button"
              aria-label="Remove file"
            >
              <X className={cn(isTouchDevice ? "size-4" : "size-3")} />
            </button>
            {/* Error tooltip */}
            {file.uploadStatus === "failed" && (
              <div className="absolute bottom-full mb-1 px-2 py-1 -left-2 bg-destructive text-destructive-foreground text-xs rounded shadow-lg whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none">
                Failed to upload
              </div>
            )}
          </div>
        ))}
      </div>
      {images.length > 0 && (
        <ImageLightboxForAttachedImage
          image={images.find((img) => img.id === expandedImageId) || null}
          images={images}
          onClose={() => setExpandedImageId(null)}
          onImageChange={(imageId) => setExpandedImageId(imageId)}
        />
      )}
    </>
  );
}
