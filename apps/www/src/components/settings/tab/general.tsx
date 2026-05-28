"use client";

import { useAtomValue } from "jotai";
import { userAtom, userSettingsAtom } from "@/atoms/user";
import {
  SettingsWithCTA,
  SettingsSection,
} from "@/components/settings/settings-row";
import { ThemeSelector } from "@/components/settings/theme-selector";
import { NotificationSettings } from "../notification-settings";
import { ThreadVisibilitySelector } from "../thread-visibility-selector";

export function GeneralSettings() {
  const user = useAtomValue(userAtom);
  const userSettings = useAtomValue(userSettingsAtom);
  if (!user || !userSettings) {
    return null;
  }
  return (
    <div className="flex flex-col gap-8">
      <SettingsSection
        label="Appearance"
        description="Choose how Terragon looks across your devices."
      >
        <SettingsWithCTA
          label="Theme"
          description="Switch between light, dark, or follow your system."
        >
          <ThemeSelector />
        </SettingsWithCTA>
      </SettingsSection>

      <SettingsSection
        label="Tasks"
        description="Defaults for new tasks you create."
      >
        <SettingsWithCTA
          label="Default visibility"
          description="Who can see new tasks. You can change this within a task at any time."
        >
          <ThreadVisibilitySelector />
        </SettingsWithCTA>
      </SettingsSection>

      <SettingsSection
        label="Notifications"
        description="Decide when Terragon nudges you."
      >
        <NotificationSettings />
      </SettingsSection>
    </div>
  );
}
