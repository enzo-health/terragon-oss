import React from "react";
import { Button } from "@/components/ui/button";
import { Square } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface StopButtonProps {
  disabled: boolean;
  handleStop: () => void;
  className?: string;
}

export function StopButton({
  disabled,
  handleStop,
  className,
}: StopButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          onClick={(event) => {
            event.preventDefault();
            handleStop();
          }}
          disabled={disabled}
          className={cn(
            disabled ? "size-8" : "size-8 animate-pulse",
            className,
          )}
          size="icon"
        >
          <Square className="size-4 fill-background" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>Stop</TooltipContent>
    </Tooltip>
  );
}
