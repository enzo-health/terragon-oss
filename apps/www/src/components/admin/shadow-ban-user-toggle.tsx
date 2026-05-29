"use client";

import { useState } from "react";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { User } from "@terragon/shared";
import { setShadowBanUser } from "@/server-actions/admin/user";

export function ShadowBanUserToggle({ user }: { user: User }) {
  const { refresh } = useRouter();
  const [pending, setPending] = useState(false);
  const checked = !!user.shadowBanned;

  return (
    <div className="flex items-center gap-3">
      <Switch
        checked={checked}
        disabled={pending}
        onCheckedChange={async (next) => {
          setPending(true);
          try {
            await setShadowBanUser({ userId: user.id, shadowBanned: next });
            toast.success(
              next ? "User shadow banned (3 tasks/hour)" : "Shadow ban removed",
            );
            refresh();
            setPending(false);
          } catch (err) {
            console.error(err);
            toast.error(
              err instanceof Error ? err.message : "Failed to update setting",
            );
            setPending(false);
          }
        }}
      />
      <Label className="text-sm">Shadow ban (3 tasks/hour)</Label>
    </div>
  );
}
