"use client";

import { useNotifications } from "@/hooks/use-notifications";
import { Button } from "@/components/ui/button";
import { Bell } from "lucide-react";
import { toast } from "sonner";
import { SettingsCheckbox, SettingsWithCTA } from "./settings-row";

export function NotificationSettings() {
  const { isSupported, permission, enabled, setEnabled, requestPermission } =
    useNotifications();

  if (!isSupported) {
    return (
      <SettingsWithCTA
        label="Browser notifications"
        description="Your browser does not support notifications."
      >
        <span />
      </SettingsWithCTA>
    );
  }

  if (permission === "denied") {
    return (
      <SettingsWithCTA
        label="Browser notifications"
        description={
          <>
            <span>Notifications are blocked. To re-enable:</span>
            <ol className="text-xs text-mid list-decimal list-inside mt-1 space-y-0.5">
              <li>Click the lock icon in your browser&apos;s address bar</li>
              <li>
                Find &quot;Notifications&quot; and change it to
                &quot;Allow&quot;
              </li>
              <li>Refresh this page</li>
              <li>
                Ensure notifications are also enabled in your operating system
                settings
              </li>
            </ol>
          </>
        }
        direction="col"
      >
        <Button
          variant="outline"
          size="sm"
          onClick={() => requestPermission()}
          className="transition-[transform,background-color,border-color] duration-[var(--duration-quick)] ease-[var(--ease-emphasis)] active:scale-[0.96]"
        >
          Try again
        </Button>
      </SettingsWithCTA>
    );
  }

  if (permission !== "granted") {
    return (
      <SettingsWithCTA
        label="Browser notifications"
        description="Get notified when tasks are complete. You may also need to enable notifications for your browser in your operating system settings."
      >
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            const result = await requestPermission();
            if (result === "granted") {
              toast.success("Settings updated.");
            }
          }}
          className="flex items-center gap-2 transition-[transform,background-color,border-color] duration-[var(--duration-quick)] ease-[var(--ease-emphasis)] active:scale-[0.96]"
        >
          <Bell className="size-3" />
          Enable
        </Button>
      </SettingsWithCTA>
    );
  }

  return (
    <SettingsCheckbox
      label="Browser notifications"
      description="Get notified when tasks are complete. You may also need to enable notifications for your browser in your operating system settings."
      value={enabled}
      onCheckedChange={(checked) => {
        setEnabled(!!checked);
        toast.success("Settings updated.");
      }}
    />
  );
}
