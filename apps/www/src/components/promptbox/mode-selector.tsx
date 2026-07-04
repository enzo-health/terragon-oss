"use client";

import {
  Select,
  SelectItem,
  SelectList,
  SelectPopup,
  SelectTrigger,
} from "@/components/ai/select";
import { cn } from "@/lib/utils";
import { memo } from "react";
import { NotebookPen, FileCode } from "lucide-react";

type PermissionMode = "allowAll" | "plan";

interface ModeSelectorProps {
  mode: PermissionMode;
  onChange: (mode: PermissionMode) => void;
  className?: string;
}

const optionValue = (value: unknown): string | undefined =>
  typeof value === "object" && value !== null && "value" in value
    ? String((value as { value: unknown }).value)
    : (value as string | undefined);

const modeConfig = {
  allowAll: { icon: FileCode, label: "Execute" },
  plan: { icon: NotebookPen, label: "Plan" },
} as const;

function ModeSelectorInner({ mode, onChange, className }: ModeSelectorProps) {
  const currentConfig = modeConfig[mode];
  const Icon = currentConfig.icon;

  const triggerClassName = cn(
    "h-8 w-auto rounded-md px-1.5 gap-1 text-muted-foreground",
    "hover:not-[[data-disabled]]:bg-muted hover:text-foreground",
    "data-[popup-open]:bg-muted data-[popup-open]:text-foreground",
    className,
  );

  return (
    <Select
      value={mode}
      isItemEqualToValue={(a: unknown, b: unknown) =>
        optionValue(a) === optionValue(b)
      }
      onValueChange={(value: unknown) =>
        onChange(optionValue(value) as PermissionMode)
      }
    >
      <SelectTrigger variant="plain" className={triggerClassName}>
        <span className="flex items-center gap-1">
          <Icon className="size-3.5 text-inherit" />
          <span>{currentConfig.label}</span>
        </span>
      </SelectTrigger>
      <SelectPopup side="top" className="w-fit">
        <SelectList>
          <SelectItem value="allowAll">
            <FileCode />
            Execute
          </SelectItem>
          <SelectItem value="plan">
            <NotebookPen />
            Plan
          </SelectItem>
        </SelectList>
      </SelectPopup>
    </Select>
  );
}

export const ModeSelector = memo(ModeSelectorInner);
