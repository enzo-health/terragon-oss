import { useMutation } from "@tanstack/react-query";
import { updateLinearSettings } from "@/server-actions/linear";
import { toast } from "sonner";
import { LinearSettingsInsert } from "@terragon/shared/db/types";
import { useRouter } from "next/navigation";

export function useUpdateLinearSettings() {
  const router = useRouter();
  return useMutation({
    mutationFn: async ({
      organizationId,
      settings,
    }: {
      organizationId: string;
      settings: Omit<LinearSettingsInsert, "userId" | "organizationId">;
    }) => {
      await updateLinearSettings({
        organizationId,
        settings,
      });
    },
    onSuccess: () => {
      toast.success("Linear settings saved");
      router.refresh();
    },
    onError: (error) => {
      console.error("Failed to save Linear settings:", error);
      toast.error("Failed to save settings");
    },
  });
}
