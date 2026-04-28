"use client";

import type { QueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { USER_CREDIT_BALANCE_QUERY_KEY } from "@/queries/user-credit-balance-queries";
import type { ArtifactDescriptor } from "@terragon/shared/db/artifact-descriptors";

/**
 * Auto-open the secondary panel the first time we observe a live git-diff
 * signal on desktop. The cookie write is owned by `setIsSecondaryPanelOpen`.
 */
export function useAutoOpenSecondaryPanelOnDiff({
  hasLiveDiffSignal,
  shouldAutoOpenSecondaryPanel,
  isSecondaryPanelOpen,
  setIsSecondaryPanelOpen,
}: {
  hasLiveDiffSignal: boolean;
  shouldAutoOpenSecondaryPanel: boolean;
  isSecondaryPanelOpen: boolean;
  setIsSecondaryPanelOpen: (open: boolean) => void;
}) {
  useEffect(() => {
    if (
      hasLiveDiffSignal &&
      shouldAutoOpenSecondaryPanel &&
      !isSecondaryPanelOpen
    ) {
      setIsSecondaryPanelOpen(true);
    }
  }, [
    hasLiveDiffSignal,
    isSecondaryPanelOpen,
    setIsSecondaryPanelOpen,
    shouldAutoOpenSecondaryPanel,
  ]);
}

/**
 * Open the secondary panel when a NEW plan artifact appears. On thread-id
 * change we re-seed the "seen" set so existing plans on a freshly mounted
 * thread aren't re-opened.
 */
export function useAutoOpenPanelOnNewPlan({
  artifactDescriptors,
  shouldAutoOpenSecondaryPanel,
  threadId,
  onOpenArtifact,
}: {
  artifactDescriptors: ArtifactDescriptor[];
  shouldAutoOpenSecondaryPanel: boolean;
  threadId: string;
  onOpenArtifact: (id: string) => void;
}) {
  const seenPlanIdsRef = useRef<Set<string>>(new Set());
  const prevThreadIdRef = useRef(threadId);
  useEffect(() => {
    const planDescriptors = artifactDescriptors.filter(
      (d) => d.kind === "plan",
    );
    if (prevThreadIdRef.current !== threadId) {
      prevThreadIdRef.current = threadId;
      seenPlanIdsRef.current = new Set(planDescriptors.map((d) => d.id));
      return;
    }
    if (!shouldAutoOpenSecondaryPanel) return;
    const newPlan = planDescriptors.findLast(
      (d) => !seenPlanIdsRef.current.has(d.id),
    );
    for (const d of planDescriptors) {
      seenPlanIdsRef.current.add(d.id);
    }
    if (newPlan) {
      onOpenArtifact(newPlan.id);
    }
  }, [
    artifactDescriptors,
    shouldAutoOpenSecondaryPanel,
    onOpenArtifact,
    threadId,
  ]);
}

/**
 * When the agent transitions from working → not-working, refresh the user
 * credit-balance query so the header reflects post-run charges.
 */
export function useInvalidateCreditBalanceOnAgentIdle({
  isAgentCurrentlyWorking,
  queryClient,
}: {
  isAgentCurrentlyWorking: boolean;
  queryClient: QueryClient;
}) {
  const previousAgentWorkingRef = useRef<boolean | null>(null);
  useEffect(() => {
    const previousIsWorking = previousAgentWorkingRef.current;
    if (
      previousIsWorking !== null &&
      previousIsWorking !== isAgentCurrentlyWorking &&
      !isAgentCurrentlyWorking
    ) {
      void queryClient.invalidateQueries({
        queryKey: USER_CREDIT_BALANCE_QUERY_KEY,
      });
    }
    previousAgentWorkingRef.current = isAgentCurrentlyWorking;
  }, [isAgentCurrentlyWorking, queryClient]);
}

/**
 * If the URL hash is `#message-N`, scroll the matching message into view
 * once after the first non-empty render. Runs at most once per mount.
 */
export function useScrollToHashMessageOnce({
  messages,
}: {
  messages: ReadonlyArray<unknown>;
}) {
  const hasScrolledRef = useRef(false);
  useEffect(() => {
    if (hasScrolledRef.current || !messages.length || !window.location.hash)
      return;
    const hash = window.location.hash.slice(1);
    const match = hash.match(/^message-(\d+)$/);
    if (!match || !match[1]) return;
    const targetIndex = parseInt(match[1], 10);
    if (targetIndex < 0 || targetIndex >= messages.length) return;
    setTimeout(() => {
      const targetElement = document.querySelector(
        `[data-message-index="${targetIndex}"]`,
      );
      if (targetElement) {
        targetElement.scrollIntoView({ behavior: "smooth", block: "start" });
      }
    }, 100);
    hasScrolledRef.current = true;
  }, [messages]);
}
