import { memo } from "react";
import { UIRichTextPart } from "@leo/shared";
import { Button } from "@/components/ui/button";
import {
  mentionPillStyle,
  linkClasses,
} from "@/components/shared/mention-pill-styles";
import { ExternalLink } from "lucide-react";

interface RichTextPartProps {
  richTextPart: UIRichTextPart;
  onOpenInArtifactWorkspace?: () => void;
}

export const RichTextPart = memo(function RichTextPart({
  richTextPart,
  onOpenInArtifactWorkspace,
}: RichTextPartProps) {
  return (
    <div className="space-y-2">
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
      <div className="whitespace-pre-wrap">
        {richTextPart.nodes.map((node, index) => {
          switch (node.type) {
            case "text":
              return <span key={index}>{node.text}</span>;
            case "mention":
              const isFolder = node.text.endsWith("/");
              return (
                <span
                  key={index}
                  className={mentionPillStyle}
                  data-is-folder={isFolder ? "true" : "false"}
                >
                  {node.text}
                </span>
              );
            case "link":
              return (
                <a
                  key={index}
                  href={node.text}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={linkClasses}
                >
                  {node.text}
                </a>
              );
            default:
              return <span key={index}>{node.text}</span>;
          }
        })}
      </div>
    </div>
  );
});
