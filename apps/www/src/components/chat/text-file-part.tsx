import React from "react";
import { FileText, Download, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";

interface TextFilePartProps {
  textFileUrl: string;
  filename?: string;
  mimeType?: string;
  onOpenInArtifactWorkspace?: () => void;
}

export function TextFilePart({
  textFileUrl,
  filename,
  mimeType,
  onOpenInArtifactWorkspace,
}: TextFilePartProps) {
  const displayName = filename || getDefaultFilename(mimeType);

  const handleDownload = () => {
    const link = document.createElement("a");
    link.href = textFileUrl;
    link.download = displayName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="inline-flex items-center gap-2 px-3 py-2 bg-muted rounded-md w-fit">
      <FileText className="size-4 text-muted-foreground flex-shrink-0" />
      <span
        className="text-sm font-medium truncate max-w-[200px]"
        title={displayName}
      >
        {displayName}
      </span>
      {onOpenInArtifactWorkspace && (
        <Button
          variant="ghost"
          size="icon"
          className="size-6 flex-shrink-0"
          onClick={onOpenInArtifactWorkspace}
          title="Open in artifact panel"
          aria-label={`Open ${displayName} in artifact workspace`}
        >
          <ExternalLink className="size-3" aria-hidden="true" />
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon"
        className="size-6 flex-shrink-0"
        onClick={handleDownload}
        title="Download file"
        aria-label={`Download ${displayName}`}
      >
        <Download className="size-3" aria-hidden="true" />
      </Button>
    </div>
  );
}

function getDefaultFilename(mimeType?: string): string {
  switch (mimeType) {
    case "text/plain":
      return "document.txt";
    case "text/markdown":
      return "document.md";
    case "text/csv":
    case "text/html":
    case "application/json":
      const extension = mimeType.split("/")[1];
      return `document.${extension}`;
    default:
      return "document.txt";
  }
}
