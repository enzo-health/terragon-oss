import { useMutation } from "@tanstack/react-query";
import { updateSlackSettings } from "@/server-actions/slack";
import { toast } from "sonner";
import { SlackSettingsInsert } from "@leo/shared";
import { useRouter } from "next/navigation";

export function useUpdateSlackSettings() {
  const router = useRouter();
  return useMutation({
    mutationFn: async ({
      teamId,
      settings,
    }: {
      teamId: string;
      settings: Omit<SlackSettingsInsert, "userId" | "teamId">;
    }) => {
      await updateSlackSettings({
        teamId,
        settings,
      });
    },
    onSuccess: () => {
      toast.success("Slack settings saved");
      router.refresh();
    },
    onError: (error) => {
      console.error("Failed to save Slack settings:", error);
      toast.error("Failed to save settings");
    },
  });
}
