"use client";

import { AlertCircle, AlertTriangle } from "lucide-react";
import { Callout, CalloutContent, CalloutIcon } from "@/components/ai/callout";
import {
  Exception,
  ExceptionContent,
  ExceptionFrames,
  ExceptionHeader,
  ExceptionMessage,
  ExceptionTrigger,
  ExceptionType,
} from "@/components/ai/exception";
import { Loader } from "@/components/ai/loader";
import { Status } from "@/components/ai/status";
import type { Leaf } from "../leaf-props";

export const ErrorLeaf: Leaf<"error"> = ({ item }) => {
  const message = item.message || "An error occurred.";
  if (item.stack) {
    return (
      <Exception>
        <ExceptionHeader>
          <ExceptionType>Error</ExceptionType>
          <ExceptionMessage>{message}</ExceptionMessage>
          <ExceptionTrigger>Details</ExceptionTrigger>
        </ExceptionHeader>
        <ExceptionContent>
          <ExceptionFrames className="whitespace-pre-wrap wrap-break-word p-3">
            {item.stack}
          </ExceptionFrames>
        </ExceptionContent>
      </Exception>
    );
  }
  return (
    <Callout tone="danger" role="alert">
      <CalloutIcon>
        <AlertCircle />
      </CalloutIcon>
      <CalloutContent>{message}</CalloutContent>
    </Callout>
  );
};

export const TransientRetryLeaf: Leaf<"transient-retry"> = ({ item }) => (
  <div className="flex items-center gap-2">
    <Status state="pending" pulse>
      <Loader variant="pulse">{item.message ?? "Retrying"}</Loader>
    </Status>
  </div>
);

export const CompactionLeaf: Leaf<"compaction"> = () => (
  <div
    className="flex items-center gap-3 text-xs text-muted-foreground animate-in fade-in duration-[var(--duration-base)] motion-reduce:animate-none"
    role="separator"
  >
    <span className="h-px flex-1 bg-border" />
    <span className="shrink-0">Context compacted</span>
    <span className="h-px flex-1 bg-border" />
  </div>
);

export const UnknownPartLeaf: Leaf<"unknown-part"> = ({ item }) => (
  <Callout tone="warning">
    <CalloutIcon>
      <AlertTriangle />
    </CalloutIcon>
    <CalloutContent>{item.label}</CalloutContent>
  </Callout>
);
