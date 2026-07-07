"use client";

import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { Download } from "lucide-react";

// `beforeinstallprompt` is not in the standard lib DOM types yet.
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const DISMISS_KEY = "terragon:pwa-install-dismissed";
const INSTALL_TOAST_ID = "pwa-install";

function isStandalone(): boolean {
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    // iOS Safari exposes standalone here instead of via display-mode.
    (window.navigator as Navigator & { standalone?: boolean }).standalone ===
      true
  );
}

/**
 * Shows a dismissible "Install Terragon" toast when Chromium fires
 * `beforeinstallprompt`. Suppressed once installed/standalone or after the
 * user dismisses it. iOS Safari never fires the event, so it gets no prompt
 * (Add-to-Home-Screen there is a manual Share-sheet action).
 */
export function InstallPrompt() {
  const deferredRef = useRef<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (isStandalone()) return;
    if (localStorage.getItem(DISMISS_KEY)) return;

    const onBeforeInstall = (event: Event) => {
      event.preventDefault();
      deferredRef.current = event as BeforeInstallPromptEvent;
      toast("Install Terragon", {
        id: INSTALL_TOAST_ID,
        description: "Add Terragon to your device for faster access.",
        icon: <Download className="size-4" />,
        position: "bottom-right",
        duration: 15000,
        action: {
          label: "Install",
          onClick: async () => {
            const deferred = deferredRef.current;
            deferredRef.current = null;
            localStorage.setItem(DISMISS_KEY, "1");
            if (!deferred) return;
            await deferred.prompt();
            await deferred.userChoice;
          },
        },
        onDismiss: () => {
          localStorage.setItem(DISMISS_KEY, "1");
        },
      });
    };

    const onInstalled = () => {
      deferredRef.current = null;
      localStorage.setItem(DISMISS_KEY, "1");
      toast.dismiss(INSTALL_TOAST_ID);
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstall);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstall);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  return null;
}
