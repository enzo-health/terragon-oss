import { useAtomValue } from "jotai";
import { userSettingsAtom, useUpdateUserSettingsMutation } from "@/atoms/user";
import type { SandboxSize } from "@terragon/types/sandbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { DEFAULT_SANDBOX_SIZE } from "@/lib/subscription-tiers";

export function SandboxSizeSelector() {
  const userSettings = useAtomValue(userSettingsAtom);
  const userSettingsMutation = useUpdateUserSettingsMutation();
  const largeSandboxSizeEnabled = useFeatureFlag("enableLargeSandboxSize");
  const canSelectLarge = largeSandboxSizeEnabled;
  return (
    <Select
      value={userSettings?.sandboxSize ?? DEFAULT_SANDBOX_SIZE}
      onValueChange={async (value) => {
        await userSettingsMutation.mutateAsync({
          sandboxSize: value as SandboxSize,
        });
      }}
    >
      <SelectTrigger className="w-fit">
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        <SelectItem value="small">Small</SelectItem>
        <SelectItem value="large" disabled={!canSelectLarge}>
          Large
        </SelectItem>
      </SelectContent>
    </Select>
  );
}
