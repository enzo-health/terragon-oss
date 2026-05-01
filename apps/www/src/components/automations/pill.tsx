import { WorkflowIcon } from "lucide-react";
import { Pill } from "../shared/pill";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";

export function AutomationPill({
  automationId,
  className,
  isReadOnly,
}: {
  automationId: string;
  className?: string;
  isReadOnly?: boolean;
}) {
  const router = useRouter();
  return (
    <Pill
      onClick={(e) => {
        if (!isReadOnly) {
          e.preventDefault();
          e.stopPropagation();
          router.push(`/automations/${automationId}`);
        }
      }}
      className={cn(
        "cursor-pointer bg-info/10 text-info",
        isReadOnly && "cursor-default",
        className,
      )}
      label={
        <>
          <WorkflowIcon className="size-2.5" />
          <span className="ml-1 font-mono hidden sm:inline">Automation</span>
        </>
      }
    />
  );
}
