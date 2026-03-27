"use client";

import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type ConversationProps = HTMLAttributes<HTMLDivElement>;

export function Conversation({
  children,
  className,
  ...props
}: ConversationProps) {
  return (
    <div className={cn("flex flex-col gap-2 w-full", className)} {...props}>
      {children}
    </div>
  );
}

type ConversationContentProps = HTMLAttributes<HTMLDivElement>;

export function ConversationContent({
  children,
  className,
  ...props
}: ConversationContentProps) {
  return (
    <div className={cn("flex flex-col gap-2 w-full", className)} {...props}>
      {children}
    </div>
  );
}
