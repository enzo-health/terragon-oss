"use client";

import { useState } from "react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { User } from "@leo/shared";
import { setShadowBanUser } from "@/server-actions/admin/user";

export function ShadowBanUserToggle({ user }: { user: User }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const checked = !!user.shadowBanned;

  return (
    <div className="flex items-center gap-3">
      <Switch
        checked={checked}
        disabled={pending}
        onCheckedChange={async (next) => {
          try {
            setPending(true);
            await setShadowBanUser({ userId: user.id, shadowBanned: next });
            toast.success(
              next ? "User shadow banned (3 tasks/hour)" : "Shadow ban removed",
            );
            router.refresh();
          } catch (err) {
            console.error(err);
            toast.error(
              err instanceof Error ? err.message : "Failed to update setting",
            );
          } finally {
            setPending(false);
          }
        }}
      />
      <Label className="text-sm">Shadow ban (3 tasks/hour)</Label>
    </div>
  );
}
