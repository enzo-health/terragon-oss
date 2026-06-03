"use client";

import * as React from "react";
import { Separator as SeparatorPrimitive } from "@base-ui/react/separator";

import { cn } from "@/lib/utils";

function Separator({
  className,
  orientation = "horizontal",
  // `decorative` is accepted for backwards compatibility with the prior Radix
  // wrapper but Base UI's Separator is always decorative (role="separator",
  // aria-orientation only), so the prop is intentionally not forwarded.
  decorative: _decorative = true,
  ...props
}: React.ComponentProps<typeof SeparatorPrimitive> & {
  decorative?: boolean;
}) {
  return (
    <SeparatorPrimitive
      data-slot="separator"
      orientation={orientation}
      className={cn(
        "bg-border shrink-0 data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px",
        className,
      )}
      {...props}
    />
  );
}

export { Separator };
