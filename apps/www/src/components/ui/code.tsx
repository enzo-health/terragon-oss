import { useState } from "react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export function CodeClickToCopy({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (copied) return;
    navigator.clipboard.writeText(text);
    toast.success("Copied");
    setCopied(true);
    setTimeout(() => {
      setCopied(false);
    }, 2000);
  };
  return (
    <code
      className={cn(
        "bg-raised text-strong inline-flex cursor-pointer items-center rounded-md border border-border px-1.5 py-0.5 font-mono text-[0.8125em] tabular-nums shadow-inset-edge transition-colors hover:bg-sunken",
        className,
      )}
      onClick={handleCopy}
    >
      {text}
    </code>
  );
}
