"use client";

import { useAtomValue } from "jotai";
import { impersonationAtom } from "@/atoms/user";
import { ImpersonationBanner } from "@/components/system/impersonation-banner";

/**
 * Client-side gate to ensure the impersonation banner has the highest priority.
 * If impersonating, render only the impersonation banner. Otherwise, render
 * whatever children are passed from the server.
 */
export function BannerPriorityGate({
  children,
}: {
  children: React.ReactNode;
}) {
  const impersonation = useAtomValue(impersonationAtom);
  if (impersonation?.isImpersonating) {
    return <ImpersonationBanner />;
  }
  return <>{children}</>;
}
