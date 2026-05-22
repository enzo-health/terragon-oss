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

function isContainerAtBottom(container: HTMLElement): boolean {
  return (
    container.scrollTop + container.clientHeight >= container.scrollHeight - 10
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
  const resizeScrollFrameRef = useRef<number | null>(null);
  const imperativeScrollFrameRef = useRef<number | null>(null);
  const lastUserScrollUpAtRef = useRef(0);

  const updateContainer = useCallback(() => {
    const nextContainer = getScrollParentOrNull(endRef.current);
    setContainer((currentContainer) =>
      currentContainer === nextContainer ? currentContainer : nextContainer,
    );
  }, []);

  const updateIsAtBottom = useCallback((nextContainer: HTMLElement) => {
    const atBottom = isContainerAtBottom(nextContainer);
    isAtBottom.current = atBottom;
    setIsAtBottomState((current) =>
      current === atBottom ? current : atBottom,
    );
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
      if (resizeScrollFrameRef.current !== null) {
        cancelAnimationFrame(resizeScrollFrameRef.current);
        resizeScrollFrameRef.current = null;
      }
      const atBottom = isContainerAtBottom(container);
      if (!atBottom) {
        lastUserScrollUpAtRef.current = performance.now();
      }
      isAtBottom.current = atBottom;
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
        if (imperativeScrollFrameRef.current !== null) {
          cancelAnimationFrame(imperativeScrollFrameRef.current);
        }
        imperativeScrollFrameRef.current = requestAnimationFrame(() => {
          imperativeScrollFrameRef.current = null;
          scrollContainerToBottom(nextContainer);
          updateIsAtBottom(nextContainer);
        });
        return;
      }

      if (endRef.current) {
        endRef.current.scrollIntoView({
          behavior,
          block: "end",
        });
      }
    },
    [scrollContainerToBottom, updateIsAtBottom],
  );

  const maybeScrollToBottom = useCallback(() => {
    const nextContainer = getScrollParentOrNull(endRef.current);
    if (!nextContainer) {
      return;
    }
    const wasPinned = isAtBottom.current;
    const currentlyAtBottom = isContainerAtBottom(nextContainer);
    const userRecentlyScrolledUp =
      performance.now() - lastUserScrollUpAtRef.current < 250;
    if (!currentlyAtBottom && userRecentlyScrolledUp) {
      updateIsAtBottom(nextContainer);
      return;
    }
    if (wasPinned || currentlyAtBottom) {
      forceScrollToBottom("auto");
    }
  }, [forceScrollToBottom, updateIsAtBottom]);

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
    if (!container || !observedNode) {
      return;
    }

    const scheduleScrollCheck = () => {
      if (resizeScrollFrameRef.current !== null) return;
      resizeScrollFrameRef.current = requestAnimationFrame(() => {
        resizeScrollFrameRef.current = null;
        maybeScrollToBottom();
      });
    };

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(scheduleScrollCheck);
      observer.observe(observedNode);
      return () => {
        observer.disconnect();
        if (resizeScrollFrameRef.current !== null) {
          cancelAnimationFrame(resizeScrollFrameRef.current);
          resizeScrollFrameRef.current = null;
        }
      };
    }

    const observer = new MutationObserver(scheduleScrollCheck);
    observer.observe(observedNode, {
      childList: true,
      subtree: true,
    });
    return () => {
      observer.disconnect();
      if (resizeScrollFrameRef.current !== null) {
        cancelAnimationFrame(resizeScrollFrameRef.current);
        resizeScrollFrameRef.current = null;
      }
    };
  }, [container, maybeScrollToBottom, observedRef]);
  useEffect(
    () => () => {
      if (imperativeScrollFrameRef.current !== null) {
        cancelAnimationFrame(imperativeScrollFrameRef.current);
      }
      if (resizeScrollFrameRef.current !== null) {
        cancelAnimationFrame(resizeScrollFrameRef.current);
      }
    },
    [],
  );
  return {
    messagesEndRef: endRef,
    isAtBottom: isAtBottomState,
    forceScrollToBottom,
  };
}
