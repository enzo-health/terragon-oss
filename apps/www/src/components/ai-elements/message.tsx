"use client";

import type { HTMLAttributes } from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const messageVariants = cva("group flex w-full", {
  variants: {
    from: {
      user: "justify-end",
      assistant: "justify-start",
      system: "justify-center",
    },
  },
  defaultVariants: {
    from: "assistant",
  },
});

type MessageProps = HTMLAttributes<HTMLDivElement> &
  VariantProps<typeof messageVariants> & {
    from: "user" | "assistant" | "system";
  };

export function Message({ className, from, ...props }: MessageProps) {
  return (
    <div className={cn(messageVariants({ from }), className)} {...props} />
  );
}

type MessageContentProps = HTMLAttributes<HTMLDivElement> & {
  from: "user" | "assistant" | "system";
};

export function MessageContent({
  children,
  className,
  from,
  ...props
}: MessageContentProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-xl p-4 break-words transition-all duration-200",
        from === "user" &&
          "bg-[var(--warm-stone)] ml-auto max-w-[85%] w-fit shadow-warm-lift",
        from === "assistant" && "mr-auto w-full bg-white shadow-outline-ring",
        from === "system" && "w-full text-center text-muted-foreground italic",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}

type MessageResponseProps = HTMLAttributes<HTMLDivElement>;

export function MessageResponse({
  children,
  className,
  ...props
}: MessageResponseProps) {
  return (
    <div
      className={cn("flex flex-col gap-3 text-sm leading-relaxed", className)}
      {...props}
    >
      {children}
    </div>
  );
}

type MessagePartProps = HTMLAttributes<HTMLDivElement>;

export function MessagePart({
  children,
  className,
  ...props
}: MessagePartProps) {
  return (
    <div
      className={cn(
        "rounded-lg border border-border/40 p-3 bg-white/50",
        className,
      )}
      {...props}
    >
      {children}
    </div>
  );
}
