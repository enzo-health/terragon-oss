import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-[color,background-color,border-color,opacity,box-shadow,transform] duration-150 active:scale-[0.98] disabled:pointer-events-none disabled:bg-disabled disabled:text-mid disabled:active:scale-100 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:ring-coral/50 focus-visible:ring-2 focus-visible:outline-none aria-invalid:ring-error/20 dark:aria-invalid:ring-error/40 aria-invalid:border-error",
  {
    variants: {
      variant: {
        default: "bg-coral text-primary-foreground hover:bg-coral-active",
        destructive:
          "bg-error text-on-dark hover:bg-error/90 focus-visible:ring-error/50",
        outline:
          "border border-hairline bg-canvas text-strong hover:bg-sunken/60",
        secondary: "bg-raised text-strong shadow-card hover:bg-sunken",
        ghost: "text-strong hover:bg-sunken/60",
        link: "text-strong underline-offset-4 hover:underline",
        warm: "bg-[var(--warm-stone)] text-strong rounded-[30px] shadow-warm-lift px-5 py-3 pr-6",
        uppercase: "uppercase tracking-[0.7px] text-sm font-bold",
      },
      size: {
        default: "h-8 px-3 py-1.5 has-[>svg]:px-2.5",
        xs: "h-7 px-2.5 py-1.5 has-[>svg]:px-2",
        sm: "h-8 gap-1.5 px-3 has-[>svg]:px-2.5",
        lg: "h-9 px-4 has-[>svg]:px-3",
        icon: "size-8",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
  }) {
  const Comp = asChild ? Slot : "button";

  return (
    <Comp
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
