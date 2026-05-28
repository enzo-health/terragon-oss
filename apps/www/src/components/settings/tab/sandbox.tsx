"use client";

import { useAtomValue } from "jotai";
import { userAtom, userSettingsAtom } from "@/atoms/user";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { SettingsWithCTA, SettingsSection } from "../settings-row";
import { SandboxSizeSelector } from "../sandbox-size-selector";
import { SandboxProviderSelector } from "../sandbox-provider-selector";

export function SandboxSettings() {
  const user = useAtomValue(userAtom);
  const userSettings = useAtomValue(userSettingsAtom);
  const largeSandboxSizeEnabled = useFeatureFlag("enableLargeSandboxSize");
  const daytonaOptionsForSandboxProviderEnabled = useFeatureFlag(
    "daytonaOptionsForSandboxProvider",
  );
  if (
    !user ||
    !userSettings ||
    (!daytonaOptionsForSandboxProviderEnabled && !largeSandboxSizeEnabled)
  ) {
    return null;
  }
  return (
    <div className="flex flex-col gap-8">
      {/* Sandbox Configuration */}
      <SettingsSection
        label="Sandbox Configuration"
        description="Configure how code is executed in isolated environments"
      >
        <div className="flex flex-col gap-4">
          <SettingsWithCTA
            label="Sandbox Provider"
            description="Choose the sandbox provider for running code"
          >
            <SandboxProviderSelector />
          </SettingsWithCTA>
        </div>
        {largeSandboxSizeEnabled && (
          <SettingsWithCTA
            label="Sandbox Size"
            description="Choose the size of the sandbox for running code"
          >
            <SandboxSizeSelector />
          </SettingsWithCTA>
        )}
      </SettingsSection>
    </div>
  );
}
