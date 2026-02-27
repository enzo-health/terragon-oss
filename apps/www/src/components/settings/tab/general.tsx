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
      {/* Appearance Section */}
      <SettingsSection label="General">
        <div className="flex flex-col gap-4">
          <SettingsWithCTA
            label="Theme"
            description="Choose between light, dark, or system theme"
          >
            <ThemeSelector />
          </SettingsWithCTA>
          <SettingsWithCTA
            label="Default task visibility"
            description="Set the default visibility of new tasks. You can always change this within a task."
          >
            <ThreadVisibilitySelector />
          </SettingsWithCTA>
          <NotificationSettings />
        </div>
      </SettingsSection>
    </div>
  );
}
