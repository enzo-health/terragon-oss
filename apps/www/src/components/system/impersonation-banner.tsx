"use client";

import { useAtomValue } from "jotai";
import { Button } from "../ui/button";
import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { toast } from "sonner";
import { impersonationAtom } from "@/atoms/user";

export function ImpersonationBanner() {
  const impersonation = useAtomValue(impersonationAtom);
  const [isLoading, setIsLoading] = useState(false);
  if (!impersonation?.isImpersonating) {
    return null;
  }
  const handleStopImpersonation = async () => {
    try {
      setIsLoading(true);
      await authClient.admin.stopImpersonating();
      window.location.href = `/internal/admin/user/${impersonation.impersonatedUser?.id}`;
    } catch (error) {
      console.error("Failed to stop impersonation:", error);
      toast.error("Failed to stop impersonation");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="sticky top-0 z-50 bg-warning/15 text-warning text-sm font-medium px-4 py-2 flex items-center justify-between border-b border-warning/40 w-full">
      <div className="flex items-center gap-1">
        <span>Logged in as:</span>
        {impersonation.impersonatedUser && (
          <span className="opacity-90">
            {impersonation.impersonatedUser.name} (
            {impersonation.impersonatedUser.email})
          </span>
        )}
      </div>
      <Button
        onClick={handleStopImpersonation}
        disabled={isLoading}
        size="sm"
        variant="link"
        className="underline cursor-pointer"
      >
        Stop
      </Button>
    </div>
  );
}
