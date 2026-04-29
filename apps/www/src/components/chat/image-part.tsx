import React from "react";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ImagePart({
  imageUrl,
  alt,
  onClick,
  onOpenInArtifactWorkspace,
}: {
  imageUrl: string;
  alt?: string;
  onClick?: () => void;
  onOpenInArtifactWorkspace?: () => void;
}) {
  const altText = alt || "Image";
  return (
    <div className="w-fit space-y-2">
      {onOpenInArtifactWorkspace && (
        <div className="flex justify-end">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={onOpenInArtifactWorkspace}
          >
            <ExternalLink className="size-3.5" />
            Open in panel
          </Button>
        </div>
      )}
      {onClick ? (
        <button
          type="button"
          onClick={onClick}
          aria-label={`View image: ${altText}`}
          className="block rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-[scale] duration-150 active:scale-[0.98]"
        >
          <img
            src={imageUrl}
            alt={altText}
            className="max-w-[200px] rounded-lg image-outline"
            loading="lazy"
            decoding="async"
          />
        </button>
      ) : (
        <img
          src={imageUrl}
          alt={altText}
          className="max-w-[200px] rounded-lg image-outline"
          loading="lazy"
          decoding="async"
        />
      )}
    </div>
  );
}
