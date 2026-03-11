import { useState, useCallback, useRef, useEffect, RefObject } from "react";

const FALLBACK_CONTAINER_WIDTH = 1024;

export interface ResizablePanelConfig {
  minWidth: number;
  /**
   * Max width - can be either:
   * - percentage (0-1) of container width, OR
   * - pixel value (>1)
   */
  maxWidth: number;
  /**
   * Default width - can be either:
   * - percentage (0-1) of container width, OR
   * - pixel value (>1)
   */
  defaultWidth: number;
  /**
   * Mode for handling container resize:
   * - "percentage": Panel resizes proportionally with container (maintains percentage)
   * - "fixed": Panel stays at fixed pixel width (doesn't resize with container)
   */
  mode: "percentage" | "fixed";
  collapseThreshold?: number;
  onCollapse?: () => void;
  /**
   * Direction of resize calculation
   * - "ltr" (left-to-right): width increases as mouse moves right (left sidebar)
   * - "rtl" (right-to-left): width increases as mouse moves left (right panel)
   */
  direction?: "ltr" | "rtl";
  /**
   * Reference to the parent container element
   * If not provided, falls back to window.innerWidth
   */
  containerRef?: RefObject<HTMLElement | null>;
  /**
   * Whether the panel is enabled/active
   * When false, skips width calculations to prevent flicker
   */
  enabled?: boolean;
}

export function useResizablePanel({
  minWidth,
  maxWidth,
  defaultWidth,
  mode,
  collapseThreshold,
  onCollapse,
  direction = "ltr",
  containerRef,
  enabled = true,
}: ResizablePanelConfig) {
  // Helper to get container width
  const getContainerWidth = useCallback(() => {
    if (containerRef?.current) {
      return containerRef.current.offsetWidth;
    }
    return typeof window !== "undefined"
      ? window.innerWidth
      : FALLBACK_CONTAINER_WIDTH;
  }, [containerRef]);

  // Determine initial width
  const getInitialState = useCallback(() => {
    const containerWidth = getContainerWidth();
    const width = defaultWidth ?? 0;
    // Calculate initial pixel width
    let pixelWidth: number;
    if (width > 0 && width <= 1) {
      // It's a percentage
      pixelWidth = width * containerWidth;
    } else {
      // It's pixels
      pixelWidth = width;
    }
    return pixelWidth;
  }, [defaultWidth, getContainerWidth]);

  const [width, setWidth] = useState<number>(() => {
    if (defaultWidth > 0 && defaultWidth <= 1) {
      return defaultWidth * FALLBACK_CONTAINER_WIDTH;
    } else {
      return defaultWidth;
    }
  });
  const [isResizing, setIsResizing] = useState(false);
  const startXRef = useRef<number>(0);
  const startWidthRef = useRef<number>(0);
  const widthPercentageRef = useRef<number>(0);
  const initializedRef = useRef(false);

  // Initialize width when enabled
  useEffect(() => {
    if (!enabled || initializedRef.current) return;

    const initialWidth = getInitialState();
    setWidth(initialWidth);
    widthPercentageRef.current =
      mode === "percentage" ? initialWidth / getContainerWidth() : 0;
    initializedRef.current = true;
  }, [enabled, getInitialState, getContainerWidth, mode]);

  // Helper to get max width
  const getMaxWidth = useCallback(() => {
    if (maxWidth > 0 && maxWidth <= 1) {
      // It's a percentage
      return getContainerWidth() * maxWidth;
    } else {
      // It's pixels
      return maxWidth;
    }
  }, [maxWidth, getContainerWidth]);

  // Update width when container resizes (only in percentage mode)
  useEffect(() => {
    if (mode !== "percentage") return;

    const container = containerRef?.current;

    // If no containerRef, fall back to window resize
    if (!container) {
      const handleResize = () => {
        const windowWidth = window.innerWidth;
        const newWidth = windowWidth * widthPercentageRef.current;
        const maxWidth = getMaxWidth();

        setWidth(Math.min(Math.max(newWidth, minWidth), maxWidth));
      };

      window.addEventListener("resize", handleResize);
      return () => window.removeEventListener("resize", handleResize);
    }

    // Use ResizeObserver for container
    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const containerWidth = entry.contentRect.width;
        const newWidth = containerWidth * widthPercentageRef.current;
        const maxWidth = getMaxWidth();

        setWidth(Math.min(Math.max(newWidth, minWidth), maxWidth));
      }
    });

    resizeObserver.observe(container);
    return () => resizeObserver.disconnect();
  }, [mode, getMaxWidth, minWidth, containerRef]);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsResizing(true);

      startXRef.current = e.pageX;
      startWidthRef.current = width;

      document.body.style.cursor =
        direction === "ltr" ? "col-resize" : "ew-resize";
      document.body.style.userSelect = "none";
    },
    [width, direction],
  );

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      const delta =
        direction === "ltr"
          ? e.pageX - startXRef.current
          : startXRef.current - e.pageX;

      const containerWidth = getContainerWidth();
      const maxWidth = getMaxWidth();
      const newWidth = Math.min(
        Math.max(startWidthRef.current + delta, minWidth),
        maxWidth,
      );

      setWidth(newWidth);

      // Update percentage ref if in percentage mode
      if (mode === "percentage") {
        widthPercentageRef.current = newWidth / containerWidth;
      }

      // Auto-collapse when resizing below threshold
      if (collapseThreshold && onCollapse && newWidth < collapseThreshold) {
        onCollapse();
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [
    isResizing,
    minWidth,
    getMaxWidth,
    collapseThreshold,
    onCollapse,
    direction,
    getContainerWidth,
    mode,
  ]);

  // Wrap setWidth so external callers (e.g. keyboard resize) also update
  // the stored percentage, keeping container-resize sync consistent.
  const setWidthAndSync = useCallback(
    (nextWidth: number | ((prev: number) => number)) => {
      setWidth((prev) => {
        const resolved =
          typeof nextWidth === "function" ? nextWidth(prev) : nextWidth;
        if (mode === "percentage") {
          widthPercentageRef.current = resolved / getContainerWidth();
        }
        return resolved;
      });
    },
    [mode, getContainerWidth],
  );

  return {
    width,
    setWidth: setWidthAndSync,
    isResizing,
    handleMouseDown,
  };
}
