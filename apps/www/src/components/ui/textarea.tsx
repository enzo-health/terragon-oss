import * as React from "react";

import { cn } from "@/lib/utils";

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "border-hairline placeholder:text-mid focus-visible:border-coral/60 focus-visible:ring-coral/20 aria-invalid:ring-error/20 dark:aria-invalid:ring-error/40 aria-invalid:border-error flex field-sizing-content min-h-[100px] w-full rounded-xl border bg-canvas px-5 py-3 text-base text-strong transition-[color,border-color,box-shadow] outline-none focus-visible:ring-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
        className,
      )}
      {...props}
    />
  );
}

export { Textarea };
