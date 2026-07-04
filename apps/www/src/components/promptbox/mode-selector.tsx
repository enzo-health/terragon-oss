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
import { NotebookPen, FileCode, Check } from "lucide-react";
import React from "react";
import { Button } from "@/components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";

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
  allowAll: {
    icon: FileCode,
    label: "Execute",
    description: "Implement immediately",
  },
  plan: {
    icon: NotebookPen,
    label: "Plan",
    description: "Approve before making changes",
  },
} as const;

function ModeSelectorInner({ mode, onChange, className }: ModeSelectorProps) {
  const [isDrawerOpen, setIsDrawerOpen] = React.useState(false);
  const currentConfig = modeConfig[mode];
  const Icon = currentConfig.icon;

  const triggerClassName = cn(
    "h-8 w-fit rounded-md px-1.5",
    "border-none shadow-none text-mid gap-0.5 hover:bg-muted hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground dark:bg-transparent",
    className,
  );

  const nauvalTriggerClassName = cn(
    "h-8 w-auto rounded-md px-1.5 gap-1 text-muted-foreground",
    "hover:not-[[data-disabled]]:bg-muted hover:text-foreground",
    "data-[popup-open]:bg-muted data-[popup-open]:text-foreground",
    className,
  );

  return (
    <>
      <Drawer
        open={isDrawerOpen}
        onOpenChange={setIsDrawerOpen}
        dismissible
        modal
      >
        <DrawerTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className={cn(triggerClassName, "flex sm:hidden")}
            aria-expanded={isDrawerOpen}
            aria-haspopup="dialog"
          >
            <span className="flex items-center gap-1">
              <Icon className="size-3.5 text-inherit" />
            </span>
          </Button>
        </DrawerTrigger>
        <DrawerContent>
          <DrawerHeader className="text-left pb-2">
            <DrawerTitle>Select Mode</DrawerTitle>
          </DrawerHeader>
          <div className="px-4 pb-6 space-y-1">
            {(
              Object.entries(modeConfig) as [
                PermissionMode,
                (typeof modeConfig)[PermissionMode],
              ][]
            ).map(([modeKey, config]) => {
              const isSelected = mode === modeKey;
              const ModeIcon = config.icon;
              return (
                <button
                  key={modeKey}
                  type="button"
                  onClick={() => {
                    onChange(modeKey);
                    setIsDrawerOpen(false);
                  }}
                  className={cn(
                    "flex w-full gap-2 items-start justify-start rounded-md border border-transparent px-3 py-2 text-left text-sm transition-colors",
                    isSelected && "bg-muted",
                    !isSelected && "hover:bg-muted/60",
                  )}
                >
                  <Check
                    className={cn(
                      "h-4 w-4 mt-0.5",
                      isSelected ? "opacity-100" : "opacity-0",
                    )}
                  />
                  <div className="flex flex-col gap-1">
                    <span className="text-sm text-foreground/90 flex items-center gap-1">
                      <ModeIcon className="size-3.5 text-inherit" />
                      {config.label}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {config.description}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </DrawerContent>
      </Drawer>
      <Select
        value={mode}
        isItemEqualToValue={(a: unknown, b: unknown) =>
          optionValue(a) === optionValue(b)
        }
        onValueChange={(value: unknown) =>
          onChange(optionValue(value) as PermissionMode)
        }
      >
        <SelectTrigger
          variant="plain"
          className={cn(nauvalTriggerClassName, "hidden sm:flex")}
        >
          <span className="flex items-center gap-1">
            <Icon className="size-3.5 text-inherit" />
            <span>{currentConfig.label}</span>
          </span>
        </SelectTrigger>
        <SelectPopup side="top" className="w-fit">
          <SelectList>
            <SelectItem value="allowAll">
              <span className="flex flex-col items-start">
                <span className="text-sm text-foreground/90 flex items-center gap-1">
                  <FileCode className="size-3.5 text-inherit" />
                  Execute
                </span>
                <span className="text-xs text-muted-foreground">
                  Implement immediately
                </span>
              </span>
            </SelectItem>
            <SelectItem value="plan">
              <span className="flex flex-col items-start">
                <span className="text-sm text-foreground/90 flex items-center gap-1">
                  <NotebookPen className="size-3.5 text-inherit" />
                  Plan
                </span>
                <span className="text-xs text-muted-foreground">
                  Approve before making changes
                </span>
              </span>
            </SelectItem>
          </SelectList>
        </SelectPopup>
      </Select>
    </>
  );
}

export const ModeSelector = memo(ModeSelectorInner);
