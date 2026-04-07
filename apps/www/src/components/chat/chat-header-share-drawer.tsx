"use client";

import React from "react";
import { toast } from "sonner";
import { ThreadInfo, ThreadVisibility } from "@terragon/shared";
import { useState } from "react";
import { Check, ChevronLeft, Link2 } from "lucide-react";
import { Button } from "../ui/button";
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle } from "../ui/drawer";
import { useUpdateThreadVisibilityMutation } from "@/queries/thread-mutations";
import { Avatar, AvatarFallback, AvatarImage } from "../ui/avatar";
import { ShareOption } from "./chat-header-share-option";

export function ShareDrawer({
  thread,
  isReadOnly,
  open,
  onOpenChange,
}: {
  thread: ThreadInfo;
  isReadOnly: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [copied, setCopied] = useState(false);
  const updateThreadVisibilityMutation = useUpdateThreadVisibilityMutation();

  const handleVisibilityChange = (visibility: ThreadVisibility) => {
    if (isReadOnly) {
      throw new Error("Only the owner can change the visibility of a task");
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
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      dismissible={true}
      modal={true}
    >
      <DrawerContent className="pb-4">
        <DrawerHeader
          className={`relative p-4 border-b ${visibility !== "private" ? "cursor-pointer active:bg-muted/50 transition-colors" : ""}`}
          onClick={visibility !== "private" ? copyTaskLink : undefined}
          role={visibility !== "private" ? "button" : undefined}
          tabIndex={visibility !== "private" ? 0 : undefined}
          onKeyDown={
            visibility !== "private"
              ? (e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    copyTaskLink();
                  }
                }
              : undefined
          }
          aria-label={
            visibility !== "private" ? "Copy task link to clipboard" : undefined
          }
        >
          <Button
            variant="ghost"
            size="icon"
            className="absolute left-4 top-1/2 -translate-y-1/2 h-8 w-8 z-10"
            onClick={(e) => {
              e.stopPropagation();
              onOpenChange(false);
            }}
            aria-label="Close share dialog"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <DrawerTitle className="text-left pl-12 pr-12">
            Share this task
          </DrawerTitle>
          {visibility !== "private" && (
            <div
              className="absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none"
              aria-hidden="true"
            >
              {copied ? (
                <Check className="h-4 w-4" />
              ) : (
                <Link2 className="h-4 w-4" />
              )}
            </div>
          )}
        </DrawerHeader>

        <div className="flex flex-col">
          {/* Control section */}
          <div className="px-4 pt-4">
            <div className="mb-4">
              <p className="text-sm text-muted-foreground">
                Control who can view this task.
              </p>
            </div>

            {/* Visibility Options */}
            <div className="flex flex-col gap-2">
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
          </div>

          <div className="border-t px-4 pt-4 mt-4">
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
                <span className="text-sm">{thread.authorName}</span>
              </div>
              <span className="text-sm text-muted-foreground">Owner</span>
            </div>
          </div>
        </div>
      </DrawerContent>
    </Drawer>
  );
}
