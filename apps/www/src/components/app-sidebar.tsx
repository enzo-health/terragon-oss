"use client";

import { useAtomValue } from "jotai";
import {
  Bot,
  Blocks,
  ChartColumnBig,
  ChevronUp,
  Container,
  GitBranch,
  Home,
  LogOut,
  MoonIcon,
  Settings,
  Shield,
  SquarePen,
  SunIcon,
  type LucideIcon,
  Workflow,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import React, { Suspense, useSyncExternalStore } from "react";
import { userAtom } from "@/atoms/user";
import { signOut } from "@/components/auth";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { headerClassName } from "./shared/header";
import { SidebarThreadListLoading } from "./sidebar-thread-list-skeleton";
import { Wordmark } from "./shared/wordmark";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";

const SidebarThreadList = dynamic(
  () => import("./sidebar-thread-list").then((mod) => mod.SidebarThreadList),
  { ssr: false, loading: () => <SidebarThreadListLoading /> },
);

const subscribeToClientSnapshot = () => () => {};
const getClientSnapshot = () => true;
const getServerSnapshot = () => false;

function useIsClient() {
  return useSyncExternalStore(
    subscribeToClientSnapshot,
    getClientSnapshot,
    getServerSnapshot,
  );
}

function SidebarHeaderContent() {
  const { open, isMobile } = useSidebar();
  if (!open && !isMobile) {
    return (
      <div className="flex items-center justify-center motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-90 motion-safe:duration-[var(--duration-base)] motion-safe:ease-[var(--ease-emphasis)]">
        <SidebarTrigger
          aria-label="Expand sidebar"
          className="text-foreground active:scale-[0.96]"
        />
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-left-1 motion-safe:duration-[var(--duration-base)] motion-safe:ease-[var(--ease-emphasis)]">
      <Wordmark href="/dashboard" />
      <SidebarTrigger />
    </div>
  );
}

export function AppSidebar() {
  const user = useAtomValue(userAtom);
  const isAdmin = user?.role === "admin";
  const { resolvedTheme, setTheme } = useTheme();
  const router = useRouter();
  const pathname = usePathname();
  const mounted = useIsClient();
  const toggleTheme = (event: Event) => {
    event.preventDefault();
    setTheme(resolvedTheme === "light" ? "dark" : "light");
  };

  return (
    <Sidebar collapsible="icon" variant="inset" className="bg-app-background">
      <SidebarHeader
        className={cn(
          "justify-center p-1.5 group-data-[collapsible=icon]:px-1.5",
          headerClassName,
        )}
      >
        <SidebarHeaderContent />
      </SidebarHeader>

      <SidebarContent className="px-1.5 pb-2 pt-0 group-data-[collapsible=icon]:px-1.5">
        <SidebarGroup className="pb-0 pt-1">
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  tooltip="New Task"
                  className="bg-primary text-primary-foreground transition-[background-color,transform] duration-[var(--duration-quick)] ease-[var(--ease-emphasis)] hover:bg-primary/90 hover:text-primary-foreground active:scale-[0.98]"
                >
                  <Link href="/dashboard" className="font-medium text-xs">
                    <SquarePen className="size-4" />
                    <span className="group-data-[collapsible=icon]:hidden">
                      New Task
                    </span>
                    <kbd className="ml-auto rounded border border-primary-foreground/25 bg-primary-foreground/10 px-1.5 py-px text-[10px] font-medium leading-none text-primary-foreground/80 group-data-[collapsible=icon]:hidden">
                      N
                    </kbd>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup className="pb-1 pt-0.5">
          <SidebarGroupContent>
            <SidebarMenu>
              <NavItem
                title="Home"
                href="/dashboard"
                icon={Home}
                isActive={pathname === "/dashboard"}
              />
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup className="flex-1 min-h-0 overflow-hidden pt-0">
          <SidebarGroupLabel className="mb-1 px-2 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            Tasks
          </SidebarGroupLabel>
          <SidebarGroupContent className="overflow-y-auto">
            <Suspense fallback={<SidebarThreadListLoading />}>
              <SidebarThreadList />
            </Suspense>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border/70 px-2 pb-1.5 pt-1.5 group-data-[collapsible=icon]:px-1.5">
        <SidebarMenu className="gap-0.5">
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton
                  size="lg"
                  tooltip="Settings"
                  className="h-10 transition-[background-color,color] duration-[var(--duration-quick)] ease-[var(--ease-emphasis)] data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                >
                  <Settings className="size-4 text-muted-foreground" />
                  <span className="flex-1 truncate text-left text-sm font-medium leading-tight group-data-[collapsible=icon]:hidden">
                    Settings
                  </span>
                  <ChevronUp
                    aria-hidden
                    className="ml-auto size-4 text-muted-foreground transition-transform duration-[var(--duration-quick)] ease-[var(--ease-emphasis)] group-data-[state=open]/menu-button:rotate-180 group-data-[collapsible=icon]:hidden"
                  />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side="top"
                align="end"
                className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg p-1"
                sideOffset={6}
              >
                <SettingsDropdownItem
                  href="/settings"
                  icon={Settings}
                  label="General"
                  onSelect={router.push}
                />
                <SettingsDropdownItem
                  href="/settings/github"
                  icon={GitBranch}
                  label="GitHub & Pull Requests"
                  onSelect={router.push}
                />
                <SettingsDropdownItem
                  href="/settings/agent"
                  icon={Bot}
                  label="Agent"
                  onSelect={router.push}
                />
                <SettingsDropdownItem
                  href="/settings/integrations"
                  icon={Blocks}
                  label="Integrations"
                  onSelect={router.push}
                />
                <SettingsDropdownItem
                  href="/automations"
                  icon={Workflow}
                  label="Automations"
                  onSelect={router.push}
                />
                <SettingsDropdownItem
                  href="/stats"
                  icon={ChartColumnBig}
                  label="Stats"
                  onSelect={router.push}
                />
                <SettingsDropdownItem
                  href="/environments"
                  icon={Container}
                  label="Environments"
                  onSelect={router.push}
                />
                {isAdmin && (
                  <SettingsDropdownItem
                    href="/internal/admin"
                    icon={Shield}
                    label="Admin Panel"
                    onSelect={router.push}
                  />
                )}
                {mounted && (
                  <DropdownMenuItem
                    onSelect={toggleTheme}
                    className="rounded-md gap-2 text-sm"
                  >
                    <ThemeToggle resolvedTheme={resolvedTheme} />
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  onClick={signOut}
                  className="rounded-md gap-2 text-sm"
                >
                  <LogOut className="size-4 text-muted-foreground" />
                  <span>Sign out</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>

          <SidebarMenuItem>
            <SidebarMenuButton
              size="lg"
              tooltip={user?.name ?? "Account"}
              className="h-10"
            >
              <Avatar className="size-7 rounded-md">
                <AvatarImage src={user?.image ?? undefined} />
                <AvatarFallback className="rounded-md bg-[var(--warm-stone)] text-foreground text-xs font-semibold">
                  {user?.name?.charAt(0) ?? "?"}
                </AvatarFallback>
              </Avatar>
              <span className="flex-1 truncate text-left text-sm font-medium leading-tight group-data-[collapsible=icon]:hidden">
                {user?.name ?? "Account"}
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

function NavItem({
  title,
  href,
  icon,
  isActive,
}: {
  title: string;
  href: string;
  icon: LucideIcon;
  isActive: boolean;
}) {
  const Icon = icon;
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={isActive} tooltip={title}>
        <Link
          href={href}
          aria-current={isActive ? "page" : undefined}
          className="font-normal text-xs transition-[background-color,color] duration-[var(--duration-quick)] ease-[var(--ease-emphasis)]"
        >
          <Icon className="size-4" />
          <span>{title}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function SettingsDropdownItem({
  href,
  icon,
  label,
  onSelect,
}: {
  href: string;
  icon: LucideIcon;
  label: string;
  onSelect: (href: string) => void;
}) {
  const Icon = icon;
  const navigateToSetting = () => {
    onSelect(href);
  };
  return (
    <DropdownMenuItem
      onClick={navigateToSetting}
      className="group/item rounded-md gap-2 text-sm transition-colors duration-[var(--duration-quick)] ease-[var(--ease-emphasis)]"
    >
      <span className="text-muted-foreground transition-colors duration-[var(--duration-quick)] group-hover/item:text-foreground group-focus/item:text-foreground">
        <Icon className="size-4" />
      </span>
      <span>{label}</span>
    </DropdownMenuItem>
  );
}

function ThemeToggle({ resolvedTheme }: { resolvedTheme: string | undefined }) {
  const isLight = resolvedTheme === "light";
  return (
    <span className="flex w-full items-center gap-2 text-sm text-foreground">
      <span className="relative size-4 text-muted-foreground">
        <span
          aria-hidden
          className="absolute inset-0 inline-flex transition-[opacity,transform] duration-[var(--duration-base)] ease-[var(--ease-emphasis)]"
          style={{
            opacity: isLight ? 1 : 0,
            transform: isLight
              ? "scale(1) rotate(0deg)"
              : "scale(0.5) rotate(-90deg)",
          }}
        >
          <SunIcon className="size-4" />
        </span>
        <span
          aria-hidden
          className="absolute inset-0 inline-flex transition-[opacity,transform] duration-[var(--duration-base)] ease-[var(--ease-emphasis)]"
          style={{
            opacity: isLight ? 0 : 1,
            transform: isLight
              ? "scale(0.5) rotate(90deg)"
              : "scale(1) rotate(0deg)",
          }}
        >
          <MoonIcon className="size-4" />
        </span>
      </span>
      <span>{isLight ? "Light mode" : "Dark mode"}</span>
    </span>
  );
}
