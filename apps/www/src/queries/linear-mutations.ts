import { updateLinearSettings } from "@/server-actions/linear";
import { toast } from "sonner";
import { LinearSettingsInsert } from "@terragon/shared/db/types";
import { useRouter } from "next/navigation";
import { useServerActionMutation } from "@/queries/server-action-helpers";

export function useUpdateLinearSettings() {
  const router = useRouter();
  return useServerActionMutation({
    mutationFn: async ({
      organizationId,
      settings,
    }: {
      organizationId: string;
      settings: Omit<LinearSettingsInsert, "userId" | "organizationId">;
    }) => {
      return await updateLinearSettings({
        organizationId,
        settings,
      });
    },
    onSuccess: () => {
      toast.success("Linear settings saved");
      router.refresh();
    },
  });
}
