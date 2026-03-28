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
        "flex flex-col gap-2 rounded-md p-2 break-words",
        from === "user" && "bg-primary/10 ml-auto max-w-[80%] w-fit",
        from === "assistant" && "mr-auto w-full",
        from === "system" && "w-full",
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
    <div className={cn("flex flex-col gap-2 text-sm", className)} {...props}>
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
      className={cn("rounded-md border border-border/50 p-2", className)}
      {...props}
    >
      {children}
    </div>
  );
}
