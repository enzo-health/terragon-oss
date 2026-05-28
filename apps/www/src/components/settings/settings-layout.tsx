"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { useRealtimeUser } from "@/hooks/useRealtime";

interface NavItem {
  href: string;
  label: string;
}

export function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const daytonaOptionsForSandboxProviderEnabled = useFeatureFlag(
    "daytonaOptionsForSandboxProvider",
  );
  useRealtimeUser({
    matches: (message) => !!message.data.userSettings,
    onMessage: () => window.location.reload(),
  });
  const navItems: NavItem[] = [
    { href: "/settings", label: "General" },
    { href: "/settings/github", label: "GitHub & PRs" },
    { href: "/settings/agent", label: "Agent" },
    { href: "/settings/integrations", label: "Integrations" },
  ];
  if (daytonaOptionsForSandboxProviderEnabled) {
    navItems.push({ href: "/settings/sandbox", label: "Sandbox" });
  }

  return (
    <div className="flex flex-col gap-4 relative">
      {/* Horizontal tab bar */}
      <nav className="sticky top-0 z-10 bg-background/95 backdrop-blur-sm border-b border-hairline">
        <div className="flex items-center gap-0.5 h-10 px-1 overflow-x-auto">
          {navItems.map((item) => {
            const isActive = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center px-3 h-7 text-sm rounded-full transition-colors whitespace-nowrap",
                  "hover:bg-sunken",
                  isActive
                    ? "bg-sunken text-strong font-medium"
                    : "text-mid hover:text-strong",
                )}
              >
                <span>{item.label}</span>
              </Link>
            );
          })}
        </div>
      </nav>
      <div className="flex flex-col gap-4 justify-start w-full max-w-4xl pt-0 sm:pt-2 pb-12 px-4 md:px-0">
        {children}
      </div>
    </div>
  );
}
