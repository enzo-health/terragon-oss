"use client";

import { useEffect } from "react";

const PROGRESS_BAR_ID = "turbo-progress-bar";
const COMPLETE_DURATION_MS = 200;

export function PageLoader() {
  useEffect(() => {
    const existing = document.getElementById(PROGRESS_BAR_ID);
    if (existing) {
      existing.classList.remove("animate-loading-complete");
      existing.classList.add("animate-loading-progress");
      existing.style.removeProperty("width");
      return cleanup;
    }

    const bar = document.createElement("div");
    bar.id = PROGRESS_BAR_ID;
    bar.style.position = "fixed";
    bar.style.top = "0";
    bar.style.left = "0";
    bar.classList.add(
      "z-[2147483647]",
      "h-[3px]",
      "w-0",
      "bg-primary",
      "transform-gpu",
      "animate-loading-progress",
    );
    document.body.appendChild(bar);
    return cleanup;
  }, []);

  return null;
}

function cleanup() {
  const bar = document.getElementById(PROGRESS_BAR_ID);
  if (!bar) return;
  bar.style.width = bar.offsetWidth + "px";
  bar.classList.remove("animate-loading-progress");
  bar.classList.add("animate-loading-complete");
  // Guard against StrictMode mount/unmount/mount: only remove if a fresh
  // PageLoader didn't re-claim the bar during the complete animation.
  setTimeout(() => {
    const current = document.getElementById(PROGRESS_BAR_ID);
    if (current?.classList.contains("animate-loading-complete")) {
      current.remove();
    }
  }, COMPLETE_DURATION_MS);
}
