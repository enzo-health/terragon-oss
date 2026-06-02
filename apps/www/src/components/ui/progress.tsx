"use client";

import * as React from "react";
import { Progress as ProgressPrimitive } from "@base-ui/react/progress";

import { cn } from "@/lib/utils";

const Progress = React.forwardRef<
  React.ComponentRef<typeof ProgressPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root>
>(({ className, value, ...props }, ref) => (
  <ProgressPrimitive.Root ref={ref} value={value} {...props}>
    <ProgressPrimitive.Track
      className={cn(
        "relative h-2 w-full overflow-hidden rounded-full bg-neutral/40",
        className,
      )}
    >
      <ProgressPrimitive.Indicator className="h-full bg-coral transition-[width] duration-300 ease-[cubic-bezier(0.2,0,0,1)]" />
    </ProgressPrimitive.Track>
  </ProgressPrimitive.Root>
));
Progress.displayName = "Progress";

export { Progress };
