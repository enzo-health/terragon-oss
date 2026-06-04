import * as React from "react";

import { cn } from "@/lib/utils";

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "file:text-strong placeholder:text-mid selection:bg-coral selection:text-primary-foreground border-hairline flex h-11 w-full min-w-0 rounded-xl border bg-canvas px-5 py-3 text-base text-strong transition-[color,border-color] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        "focus-visible:border-coral/60 focus-visible:ring-coral/20 focus-visible:ring-2 focus-visible:outline-none",
        "aria-invalid:ring-error/20 dark:aria-invalid:ring-error/40 aria-invalid:border-error",
        // Prevent iOS zoom on input focus by ensuring font-size is at least 16px
        "[&:not(:has(~ .text-sm))]:text-base",
        className,
      )}
      {...props}
    />
  );
}

export { Input };
