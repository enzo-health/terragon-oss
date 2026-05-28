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
  const initialAutoPinGraceUntilRef = useRef(0);
  const initialAutoPinnedScrollTopRef = useRef(0);

  const updateContainer = useCallback(() => {
    const nextContainer = getScrollParentOrNull(endRef.current);
    setContainer((currentContainer) =>
      currentContainer === nextContainer ? currentContainer : nextContainer,
    );
  }, []);

  const setIsAtBottom = useCallback((atBottom: boolean) => {
    isAtBottom.current = atBottom;
    setIsAtBottomState((current) =>
      current === atBottom ? current : atBottom,
    );
  }, []);

  const updateIsAtBottom = useCallback(
    (nextContainer: HTMLElement) => {
      const atBottom = isContainerAtBottom(nextContainer);
      setIsAtBottom(atBottom);
      return atBottom;
    },
    [setIsAtBottom],
  );

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
          initialAutoPinnedScrollTopRef.current = nextContainer.scrollTop;
          setIsAtBottom(true);
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
    [scrollContainerToBottom, setIsAtBottom],
  );

  const maybeScrollToBottom = useCallback(() => {
    const nextContainer = getScrollParentOrNull(endRef.current);
    if (!nextContainer) {
      return;
    }
    const wasPinned = isAtBottom.current;
    const withinInitialAutoPinGrace =
      performance.now() < initialAutoPinGraceUntilRef.current;
    const userRecentlyScrolledUp =
      performance.now() - lastUserScrollUpAtRef.current < 250;
    const changedFromInitialAutoPin =
      nextContainer.scrollTop !== initialAutoPinnedScrollTopRef.current;
    if (wasPinned && withinInitialAutoPinGrace && changedFromInitialAutoPin) {
      setIsAtBottom(false);
      return;
    }
    if (wasPinned && userRecentlyScrolledUp) {
      setIsAtBottom(false);
      return;
    }
    if (wasPinned) {
      scrollContainerToBottom(nextContainer);
      initialAutoPinnedScrollTopRef.current = nextContainer.scrollTop;
      setIsAtBottom(true);
      return;
    }

    const currentlyAtBottom = isContainerAtBottom(nextContainer);
    if (!currentlyAtBottom && userRecentlyScrolledUp) {
      setIsAtBottom(false);
      return;
    }
    if (currentlyAtBottom) {
      scrollContainerToBottom(nextContainer);
      initialAutoPinnedScrollTopRef.current = nextContainer.scrollTop;
      setIsAtBottom(true);
    }
  }, [scrollContainerToBottom, setIsAtBottom]);

  useLayoutEffect(() => {
    if (!container || hasInitialScrollRef.current) {
      return;
    }

    if (!shouldPreserveInitialPosition(container)) {
      scrollContainerToBottom(container);
      initialAutoPinnedScrollTopRef.current = container.scrollTop;
      initialAutoPinGraceUntilRef.current = performance.now() + 250;
      setIsAtBottom(true);
      hasInitialScrollRef.current = true;
      return;
    }
    updateIsAtBottom(container);
    hasInitialScrollRef.current = true;
  }, [
    container,
    scrollContainerToBottom,
    setIsAtBottom,
    shouldPreserveInitialPosition,
    updateIsAtBottom,
  ]);

  useEffect(() => {
    const observedNode = observedRef?.current ?? container;
    if (!container || !observedNode) {
      return;
    }

    let isActive = true;
    const scheduleScrollCheck = () => {
      if (!isActive) return;
      if (resizeScrollFrameRef.current !== null) return;
      resizeScrollFrameRef.current = requestAnimationFrame(() => {
        if (!isActive) return;
        resizeScrollFrameRef.current = null;
        maybeScrollToBottom();
      });
    };

    if (typeof ResizeObserver !== "undefined") {
      const observer = new ResizeObserver(scheduleScrollCheck);
      observer.observe(observedNode);
      return () => {
        isActive = false;
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
      isActive = false;
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
