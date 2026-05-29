"use client";

import { useRouter } from "next/navigation";
import { Switch } from "@/components/ui/switch";
import { updateUserFlags } from "@/server-actions/admin/user";
import { toast } from "sonner";

export function UserFlagToggle({
  userId,
  flagName,
  value,
}: {
  userId: string;
  flagName: string;
  value: boolean;
}) {
  const { refresh } = useRouter();
  return (
    <div className="flex items-center gap-2">
      <Switch
        checked={value}
        onCheckedChange={async (checked) => {
          try {
            await updateUserFlags(userId, { [flagName]: checked });
            refresh();
            toast.success("User flag updated");
          } catch (error) {
            console.error(error);
            toast.error(`Failed to update user flag`);
          }
        }}
      />
    </div>
  );
}
