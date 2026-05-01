import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

// Status pill canonical pattern: bg-{semantic}/10 text-{semantic}, rounded-full.
// Variants route through semantic tokens so theme behavior cascades correctly;
// `neutral` is the default and matches the prior muted/border treatment so
// existing call sites keep their look without any prop change.
const pillVariants = cva(
  "inline-flex items-center rounded-full font-medium px-2 py-0.5 text-[11px]",
  {
    variants: {
      variant: {
        neutral: "bg-muted text-muted-foreground border border-border",
        info: "bg-info/10 text-info",
        success: "bg-success/10 text-success",
        warning: "bg-warning/10 text-warning",
        error: "bg-error/10 text-error",
      },
    },
    defaultVariants: {
      variant: "neutral",
    },
  },
);

export type PillVariant = NonNullable<
  VariantProps<typeof pillVariants>["variant"]
>;

export function Pill({
  label,
  onClick,
  className,
  variant,
}: {
  label: string | React.ReactNode;
  onClick?: (e: React.MouseEvent<HTMLSpanElement>) => void;
  className?: string;
  variant?: PillVariant;
}) {
  return (
    <span
      onClick={onClick}
      className={cn(pillVariants({ variant }), className)}
    >
      {label}
    </span>
  );
}
