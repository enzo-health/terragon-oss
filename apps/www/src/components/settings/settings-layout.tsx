"use client";

import { usePathname } from "next/navigation";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { useSetAtom } from "jotai";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { useRealtimeUser } from "@/hooks/useRealtime";
import { userSettingsRefetchAtom } from "@/atoms/user";

interface NavItem {
  href: string;
  label: string;
  description: string;
}

export function SettingsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const daytonaOptionsForSandboxProviderEnabled = useFeatureFlag(
    "daytonaOptionsForSandboxProvider",
  );
  const refetchUserSettings = useSetAtom(userSettingsRefetchAtom);
  useRealtimeUser({
    matches: (message) => !!message.data.userSettings,
    onMessage: () => refetchUserSettings(),
  });
  const navItems: NavItem[] = [
    {
      href: "/settings",
      label: "General",
      description: "Account, theme, notifications, and task visibility.",
    },
    {
      href: "/settings/github",
      label: "GitHub & PRs",
      description: "Repository access, branch prefix, and PR defaults.",
    },
    {
      href: "/settings/agent",
      label: "Agent",
      description: "System prompt, available agents, and provider credentials.",
    },
    {
      href: "/settings/integrations",
      label: "Integrations",
      description: "Slack, Linear, and other connected services.",
    },
  ];
  if (daytonaOptionsForSandboxProviderEnabled) {
    navItems.push({
      href: "/settings/sandbox",
      label: "Sandbox",
      description: "Sandbox provider and runtime size.",
    });
  }

  const activeItem =
    navItems.find((item) => item.href === pathname) ?? navItems[0]!;

  return (
    <div className="mx-auto w-full max-w-6xl px-4 md:px-8 py-8 md:py-12">
      <div className="grid gap-10 md:grid-cols-[200px_1fr] md:gap-12">
        <SettingsNav items={navItems} pathname={pathname} />
        <main className="min-w-0 animate-in fade-in duration-[var(--duration-base)] ease-[var(--ease-emphasis)]">
          <header className="mb-8">
            <h1 className="font-display text-3xl font-normal tracking-[-0.025em] leading-[1.1] text-strong text-balance">
              {activeItem.label}
            </h1>
            <p className="mt-2 text-sm leading-relaxed text-mid text-pretty">
              {activeItem.description}
            </p>
          </header>
          <div className="flex flex-col gap-6">{children}</div>
        </main>
      </div>
    </div>
  );
}

function SettingsNav({
  items,
  pathname,
}: {
  items: NavItem[];
  pathname: string;
}) {
  return (
    <nav
      aria-label="Settings"
      className="md:sticky md:top-6 md:self-start md:max-h-[calc(100vh-3rem)] md:overflow-y-auto"
    >
      <p className="px-3 text-[11px] font-medium uppercase tracking-[0.14em] text-mid mb-2">
        Settings
      </p>
      <ul className="flex md:flex-col gap-0.5 overflow-x-auto md:overflow-visible">
        {items.map((item) => {
          const isActive = pathname === item.href;
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "flex h-9 items-center rounded-md px-3 text-sm whitespace-nowrap transition-colors duration-[var(--duration-quick)] ease-[var(--ease-emphasis)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
                  isActive
                    ? "bg-sunken text-strong font-medium"
                    : "text-mid hover:text-strong hover:bg-sunken/50",
                )}
              >
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
