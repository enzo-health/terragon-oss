"use client";

import { useEffect, type RefObject } from "react";
import { useConversation } from "@/components/ai/conversation";

export type ScrollController = {
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  scrollToTop: () => void;
};

export function ScrollBridge({
  controller,
}: {
  controller: RefObject<ScrollController | null>;
}) {
  const { scrollToBottom } = useConversation();

  useEffect(() => {
    controller.current = {
      scrollToBottom,
      scrollToTop: () => {
        const viewport = document.querySelector<HTMLElement>(
          '[data-slot="conversation-content"]',
        );
        viewport?.scrollTo({ top: 0, behavior: "smooth" });
      },
    };
    return () => {
      controller.current = null;
    };
  }, [controller, scrollToBottom]);

  return null;
}
