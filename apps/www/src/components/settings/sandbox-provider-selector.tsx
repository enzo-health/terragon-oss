import { useAtomValue } from "jotai";
import type { UserSettings } from "@terragon/shared";
import { userSettingsAtom, useUpdateUserSettingsMutation } from "@/atoms/user";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useFeatureFlag } from "@/hooks/use-feature-flag";

export function SandboxProviderSelector() {
  const userSettings = useAtomValue(userSettingsAtom);
  const userSettingsMutation = useUpdateUserSettingsMutation();
  const isOpensandboxProviderEnabled = useFeatureFlag("opensandboxProvider");
  return (
    <Select
      value={userSettings?.sandboxProvider}
      onValueChange={async (value) => {
        await userSettingsMutation.mutateAsync({
          sandboxProvider: value as UserSettings["sandboxProvider"],
        });
      }}
    >
      <SelectTrigger className="w-fit">
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        <SelectItem value="default">Default</SelectItem>
        <SelectItem value="e2b">E2B</SelectItem>
        <SelectItem value="daytona">Daytona</SelectItem>
        {isOpensandboxProviderEnabled && (
          <SelectItem value="opensandbox">Mac Mini (OpenSandbox)</SelectItem>
        )}
      </SelectContent>
    </Select>
  );
}
