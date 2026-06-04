"use client";

import type { ThreadInfo } from "@terragon/shared/db/types";
import React, { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useUpdateThreadNameMutation } from "@/queries/thread-mutations";
import { Input } from "../ui/input";
import {
  stopLinkEventPropagation,
  stopTouchEventPropagation,
} from "./item-events";

type InlineNameEditorProps = {
  thread: ThreadInfo;
  onDone: () => void;
};

export function InlineNameEditor({ thread, onDone }: InlineNameEditorProps) {
  const [editedName, setEditedName] = useState(thread.name || "");
  const inputRef = useRef<HTMLInputElement>(null);
  const updateNameMutation = useUpdateThreadNameMutation();

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleSave = () => {
    const trimmedName = editedName.trim();
    if (!trimmedName || trimmedName === thread.name) {
      onDone();
      return;
    }
    updateNameMutation.mutate(
      { threadId: thread.id, name: trimmedName },
      {
        onSuccess: () => onDone(),
        onError: () => toast.error("Failed to rename task"),
      },
    );
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSave();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onDone();
    }
  };
  const updateEditedName = (event: React.ChangeEvent<HTMLInputElement>) => {
    setEditedName(event.target.value);
  };

  return (
    <Input
      ref={inputRef}
      value={editedName}
      onChange={updateEditedName}
      onBlur={handleSave}
      onKeyDown={handleKeyDown}
      aria-label="Task name"
      className="h-auto py-0 px-1 text-[13px] font-medium leading-snug border-0 bg-transparent focus-visible:ring-1 focus-visible:ring-ring rounded-sm flex-1 min-w-0"
      placeholder={thread.name || "Untitled"}
      onClick={stopLinkEventPropagation}
      onTouchStart={stopTouchEventPropagation}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
    />
  );
}
