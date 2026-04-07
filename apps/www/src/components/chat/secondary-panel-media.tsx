import { type UIImagePart, type UIPdfPart } from "@terragon/shared";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";

export function MediaArtifactRenderer({
  mediaPart,
}: {
  mediaPart: UIImagePart | UIPdfPart;
}) {
  if (mediaPart.type === "image") {
    return (
      <div className="flex h-full items-center justify-center overflow-auto bg-muted/20 p-4">
        <img
          src={mediaPart.image_url}
          alt="Artifact preview"
          className="max-h-full max-w-full rounded-xl border bg-background object-contain shadow-sm"
        />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b px-4 py-3 flex items-center justify-between gap-3">
        <p className="truncate text-sm font-medium">
          {mediaPart.filename || "PDF document"}
        </p>
        <Button asChild variant="outline" size="sm" className="shrink-0">
          <a href={mediaPart.pdf_url} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="size-4" />
            Open PDF
          </a>
        </Button>
      </div>
      <iframe
        src={mediaPart.pdf_url}
        title={mediaPart.filename || "PDF document"}
        className="min-h-0 h-full w-full"
      />
    </div>
  );
}
