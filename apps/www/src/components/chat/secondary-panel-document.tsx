import { type UIRichTextPart } from "@terragon/shared";
import { RichTextPart } from "./rich-text-part";

export function DocumentArtifactRenderer({
  richTextPart,
}: {
  richTextPart: UIRichTextPart;
}) {
  return (
    <div className="h-full overflow-auto p-4">
      <div className="rounded-xl border bg-card p-4 shadow-sm">
        <RichTextPart richTextPart={richTextPart} />
      </div>
    </div>
  );
}
