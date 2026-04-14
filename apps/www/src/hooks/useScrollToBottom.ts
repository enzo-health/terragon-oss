import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  type RefObject,
  useState,
} from "react";
import { isIOSSafari } from "@/lib/browser-utils";

function getScrollParentOrNull(
  element: HTMLElement | null,
): HTMLElement | null {
  if (!element) {
    return null;
  }
  // Find the closest parent that is a scroll area
  let current: HTMLElement | null = element;
  while (current) {
    if (current.getAttribute("data-slot") === "scroll-area-viewport") {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function isNavigationEntryWithType(
  value: PerformanceEntry | undefined,
): value is PerformanceEntry & { type: string } {
  return (
    value !== undefined &&
    typeof value === "object" &&
    "type" in value &&
    typeof value.type === "string"
  );
}

export function useScrollToBottom({
  observedRef,
}: {
  observedRef?: RefObject<HTMLElement | null>;
} = {}): {
  messagesEndRef: RefObject<HTMLDivElement | null>;
  isAtBottom: boolean;
  forceScrollToBottom: () => void;
} {
  const isAtBottom = useRef(false);
  const [isAtBottomState, setIsAtBottomState] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const hasInitialScrollRef = useRef(false);

  const updateContainer = useCallback(() => {
    const nextContainer = getScrollParentOrNull(endRef.current);
    setContainer((currentContainer) =>
      currentContainer === nextContainer ? currentContainer : nextContainer,
    );
  }, []);

  const updateIsAtBottom = useCallback((nextContainer: HTMLElement) => {
    const atBottom =
      nextContainer.scrollTop + nextContainer.clientHeight >=
      nextContainer.scrollHeight - 10;
    isAtBottom.current = atBottom;
    setIsAtBottomState(atBottom);
    return atBottom;
  }, []);

  const scrollContainerToBottom = useCallback((nextContainer: HTMLElement) => {
    nextContainer.scrollTop = nextContainer.scrollHeight;
  }, []);

  useLayoutEffect(() => {
    updateContainer();
  }, [updateContainer]);

  const shouldPreserveInitialPosition = useCallback(
    (nextContainer: HTMLElement) => {
      if (typeof window === "undefined") {
        return false;
      }

      if (window.location.hash.length > 0 || nextContainer.scrollTop > 0) {
        return true;
      }

      const [navigationEntry] =
        window.performance.getEntriesByType("navigation");
      return (
        isNavigationEntryWithType(navigationEntry) &&
        navigationEntry.type === "back_forward"
      );
    },
    [],
  );

  useEffect(() => {
    if (!container) {
      return;
    }

    updateIsAtBottom(container);

    // Coalesce rapid scroll events into a single rAF to avoid
    // re-rendering the scroll-to-bottom button on every pixel.
    let rafId: number | null = null;
    const onScroll = () => {
      if (rafId === null) {
        rafId = requestAnimationFrame(() => {
          rafId = null;
          updateIsAtBottom(container);
        });
      }
    };

    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", onScroll);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [container, updateIsAtBottom]);

  const forceScrollToBottom = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      const nextContainer = getScrollParentOrNull(endRef.current);

      if (!nextContainer) {
        return;
      }

      if (behavior !== "smooth" || isIOSSafari()) {
        requestAnimationFrame(() => {
          scrollContainerToBottom(nextContainer);
          updateIsAtBottom(nextContainer);
        });
        return;
      }

      if (endRef.current) {
        endRef.current.scrollIntoView({
          behavior,
          block: "start",
        });
      }
    },
    [scrollContainerToBottom, updateIsAtBottom],
  );

  const maybeScrollToBottom = useCallback(() => {
    if (isAtBottom.current) {
      forceScrollToBottom("auto");
    }
  }, [forceScrollToBottom]);

  useLayoutEffect(() => {
    if (!container || hasInitialScrollRef.current) {
      return;
    }

    let firstFrame = 0;
    let secondFrame = 0;

    // Wait briefly so hash navigation and browser restoration can set the
    // viewport before we decide whether to pin the thread to the bottom.
    firstFrame = requestAnimationFrame(() => {
      secondFrame = requestAnimationFrame(() => {
        if (!shouldPreserveInitialPosition(container)) {
          scrollContainerToBottom(container);
        }
        updateIsAtBottom(container);
        hasInitialScrollRef.current = true;
      });
    });

    return () => {
      cancelAnimationFrame(firstFrame);
      cancelAnimationFrame(secondFrame);
    };
  }, [
    container,
    scrollContainerToBottom,
    shouldPreserveInitialPosition,
    updateIsAtBottom,
  ]);

  useEffect(() => {
    const observedNode = observedRef?.current ?? container;
    if (container && observedNode) {
      // Coalesce rapid DOM mutations (e.g. streaming text) into one
      // scroll-to-bottom check per frame instead of per mutation.
      let rafId: number | null = null;
      const observer = new MutationObserver(() => {
        if (rafId === null) {
          rafId = requestAnimationFrame(() => {
            rafId = null;
            maybeScrollToBottom();
          });
        }
      });
      observer.observe(observedNode, {
        childList: true,
        subtree: true,
      });
      return () => {
        observer.disconnect();
        if (rafId !== null) cancelAnimationFrame(rafId);
      };
    }
  }, [container, maybeScrollToBottom, observedRef]);
  return {
    messagesEndRef: endRef,
    isAtBottom: isAtBottomState,
    forceScrollToBottom,
  };
}
