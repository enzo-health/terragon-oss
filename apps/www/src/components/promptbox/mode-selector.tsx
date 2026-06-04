"use client";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
    "w-fit px-1",
    "border-none shadow-none hover:bg-transparent text-muted-foreground/70 hover:text-foreground gap-0.5 dark:bg-transparent dark:hover:bg-transparent",
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
        onValueChange={(value) => onChange(value as PermissionMode)}
      >
        <SelectTrigger
          className={cn(triggerClassName, "hidden sm:flex")}
          size="sm"
        >
          <SelectValue asChild>
            <span className="flex items-center gap-1">
              <Icon className="size-3.5 text-inherit" />
              <span className="hidden sm:inline">{currentConfig.label}</span>
            </span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent className="w-fit">
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
        </SelectContent>
      </Select>
    </>
  );
}

export const ModeSelector = memo(ModeSelectorInner);
