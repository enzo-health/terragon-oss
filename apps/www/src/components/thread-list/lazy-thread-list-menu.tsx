"use client";

import type { ThreadInfo } from "@terragon/shared/db/types";
import { EllipsisVerticalIcon } from "lucide-react";
import React, { useEffect, useRef, useState } from "react";
import { ThreadMenuDropdown } from "../thread-menu-dropdown";
import { Button } from "../ui/button";

type LazyThreadListMenuProps = {
  thread: ThreadInfo;
  onRenameClick: () => void;
  onMenuOpenChange: (open: boolean) => void;
};

export function LazyThreadListMenu({
  thread,
  onRenameClick,
  onMenuOpenChange,
}: LazyThreadListMenuProps) {
  const [activated, setActivated] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const pendingClickRef = useRef(false);

  useEffect(() => {
    if (activated && pendingClickRef.current && triggerRef.current) {
      pendingClickRef.current = false;
      triggerRef.current.click();
    }
  }, [activated]);

  const activateMenu = () => {
    setActivated(true);
  };
  const activateMenuFromClick = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setActivated(true);
    pendingClickRef.current = true;
  };
  const activateMenuFromKeyboard = (event: React.KeyboardEvent) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      setActivated(true);
      pendingClickRef.current = true;
    }
  };

  const menuTrigger = (
    <Button
      ref={triggerRef}
      variant="ghost"
      size="icon"
      aria-label="Thread options"
      className="w-fit px-1 hover:bg-transparent cursor-pointer"
    >
      <EllipsisVerticalIcon className="size-4 text-muted-foreground hover:text-foreground transition-colors" />
    </Button>
  );

  if (!activated) {
    return (
      <Button
        ref={triggerRef}
        variant="ghost"
        size="icon"
        aria-label="Thread options"
        className="w-fit px-1 hover:bg-transparent cursor-pointer"
        onPointerEnter={activateMenu}
        onClick={activateMenuFromClick}
        onKeyDown={activateMenuFromKeyboard}
      >
        <EllipsisVerticalIcon className="size-4 text-muted-foreground hover:text-foreground transition-colors" />
      </Button>
    );
  }

  return (
    <ThreadMenuDropdown
      thread={thread}
      trigger={menuTrigger}
      showReadUnreadActions
      showRenameAction
      onRenameClick={onRenameClick}
      onMenuOpenChange={onMenuOpenChange}
    />
  );
}
