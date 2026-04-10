"use client";

import React from "react";
import { toast } from "sonner";
import { ThreadInfo, ThreadVisibility } from "@leo/shared";
import { useState } from "react";
import { Check, Lock, Link2, Users, Globe } from "lucide-react";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { useUpdateThreadVisibilityMutation } from "@/queries/thread-mutations";
import { Avatar, AvatarFallback, AvatarImage } from "../ui/avatar";
import { ShareOption } from "./chat-header-share-option";

export function ShareButton({
  thread,
  isReadOnly,
}: {
  thread: ThreadInfo;
  isReadOnly: boolean;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const updateThreadVisibilityMutation = useUpdateThreadVisibilityMutation();

  const handleVisibilityChange = (visibility: ThreadVisibility) => {
    if (isReadOnly) {
      throw new Error("Cannot change visibility of a read-only task");
    }
    updateThreadVisibilityMutation.mutate({
      threadId: thread.id,
      visibility,
    });
  };

  const copyTaskLink = async () => {
    try {
      const url = `${window.location.origin}/task/${thread.id}`;
      await navigator.clipboard.writeText(url);
      toast.success("Task link copied");
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy link", err);
      toast.error("Failed to copy link");
    }
  };

  const visibility = thread.visibility;
  return (
    <>
      <Popover
        open={isOpen}
        onOpenChange={(open: boolean) => {
          setIsOpen(open);
        }}
      >
        <PopoverTrigger asChild>
          <Button
            variant="default"
            size="default"
            className="gap-2"
            aria-label="Share this task"
            aria-haspopup="dialog"
            aria-expanded={isOpen}
          >
            {visibility === "private" ? (
              <Lock className="h-3 w-3" aria-hidden="true" />
            ) : visibility === "link" ? (
              <Globe className="h-3 w-3" aria-hidden="true" />
            ) : visibility === "repo" ? (
              <Users className="h-3 w-3" aria-hidden="true" />
            ) : null}
            <span className="hidden sm:inline">Share</span>
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto min-w-[280px] p-0" align="end">
          <div className="flex flex-col">
            <button
              className={`p-3 border-b w-full text-left ${visibility !== "private" ? "cursor-pointer hover:bg-muted/50 transition-colors" : ""}`}
              onClick={visibility !== "private" ? copyTaskLink : undefined}
              disabled={visibility === "private"}
              aria-label={
                visibility !== "private"
                  ? "Copy task link to clipboard"
                  : undefined
              }
              type="button"
            >
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-medium">Share this task</h4>
                {visibility !== "private" && (
                  <div className="pointer-events-none" aria-hidden="true">
                    {copied ? (
                      <Check className="size-4" />
                    ) : (
                      <Link2 className="size-4" />
                    )}
                  </div>
                )}
              </div>
            </button>

            <div className="">
              <div className="px-3 pt-2 pb-1">
                <p className="text-xs text-muted-foreground">
                  Control who can view this task.
                </p>
              </div>

              {/* Visibility Options */}
              <div className="px-1 py-1">
                <ShareOption
                  visibility="private"
                  isSelected={visibility === "private"}
                  onClick={() => handleVisibilityChange("private")}
                  disabled={isReadOnly}
                />
                <ShareOption
                  visibility="link"
                  isSelected={visibility === "link"}
                  onClick={() => handleVisibilityChange("link")}
                  disabled={isReadOnly}
                />
                <ShareOption
                  visibility="repo"
                  isSelected={visibility === "repo"}
                  onClick={() => handleVisibilityChange("repo")}
                  disabled={isReadOnly}
                />
              </div>

              <div className="border-t p-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Avatar className="h-6 w-6">
                      {thread.authorImage && (
                        <AvatarImage src={thread.authorImage} />
                      )}
                      <AvatarFallback className="text-xs">
                        {thread.authorName?.charAt(0) || ""}
                      </AvatarFallback>
                    </Avatar>
                    <span className="text-xs">{thread.authorName}</span>
                  </div>
                  <span className="text-xs text-muted-foreground">Owner</span>
                </div>
              </div>
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </>
  );
}
