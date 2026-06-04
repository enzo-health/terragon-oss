import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border border-transparent px-2.5 py-0.5 text-[11px] font-medium transition-[color,background-color,border-color,box-shadow] duration-200 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 tracking-[0.02em] font-sans",
  {
    variants: {
      variant: {
        default: "bg-raised text-strong shadow-inset-edge",
        secondary: "bg-sunken text-strong shadow-inset-edge",
        destructive: "bg-error/10 text-error-strong",
        success: "bg-success/10 text-success-strong",
        warning: "bg-warning/10 text-warning-strong",
        info: "bg-info/10 text-info-strong",
        outline: "text-mid border-border",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  );
}

export { Badge, badgeVariants };
