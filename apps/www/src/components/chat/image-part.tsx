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
      <img
        src={imageUrl}
        alt={alt || "Image"}
        className={`max-w-[200px] ${onClick ? "cursor-pointer" : ""}`}
        loading="lazy"
        decoding="async"
        onClick={onClick}
      />
    </div>
  );
}
