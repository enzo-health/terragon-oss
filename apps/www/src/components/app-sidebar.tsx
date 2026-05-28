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
  Workflow,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import React, { Suspense, useEffect, useState } from "react";
import { userAtom } from "@/atoms/user";
import { signOut } from "@/components/auth";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
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
import { Wordmark, WordmarkLogo } from "./shared/wordmark";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";

const SidebarThreadList = dynamic(
  () => import("./sidebar-thread-list").then((mod) => mod.SidebarThreadList),
  { ssr: false, loading: () => <SidebarThreadListLoading /> },
);

// Loading fallback — used in the Suspense boundary inside the sidebar
function SidebarThreadListLoading() {
  return (
    <div className="flex flex-col gap-2 px-3 py-3">
      <div className="h-3 w-20 rounded bg-muted animate-pulse" />
      <div className="h-8 rounded-md bg-muted/70 animate-pulse" />
      <div className="h-8 rounded-md bg-muted/50 animate-pulse" />
      <div className="h-8 rounded-md bg-muted/40 animate-pulse" />
    </div>
  );
}

function SidebarHeaderContent() {
  const { open, isMobile, toggleSidebar } = useSidebar();
  if (!open && !isMobile) {
    return (
      <div className="flex items-center justify-center">
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleSidebar}
          className="size-8 rounded-md border border-border/70 bg-background/90 text-foreground shadow-[var(--shadow-outline-ring)] hover:bg-accent/80"
        >
          <WordmarkLogo size="md" />
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center justify-between">
      <Wordmark href="/dashboard" />
      <SidebarTrigger />
    </div>
  );
}

export function AppSidebar() {
  const user = useAtomValue(userAtom);
  const isAdmin = user?.role === "admin";
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    setMounted(true);
  }, []);

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
        {/* New Task Button */}
        <SidebarGroup className="py-1">
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  asChild
                  tooltip="New Task"
                  className="bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground"
                >
                  <Link href="/dashboard" className="font-medium text-xs">
                    <SquarePen className="h-3.5 w-3.5" />
                    <span>New Task</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* Home nav */}
        <SidebarGroup className="py-0.5">
          <SidebarGroupContent>
            <SidebarMenu>
              <NavItem
                title="Home"
                href="/dashboard"
                icon={<Home className="h-3.5 w-3.5" />}
                isActive={pathname === "/dashboard"}
              />
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>

        {/* Sessions grouped by repo */}
        <SidebarGroup className="flex-1 min-h-0 overflow-hidden">
          <SidebarGroupLabel className="mb-0.5 px-2.5 text-[10px]">
            Sessions
          </SidebarGroupLabel>
          <SidebarGroupContent className="overflow-y-auto">
            <Suspense fallback={<SidebarThreadListLoading />}>
              <SidebarThreadList />
            </Suspense>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border/70 px-2 pb-2 pt-2 group-data-[collapsible=icon]:px-1.5">
        <SidebarMenu>
          {/* Settings gear */}
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton
                  size="lg"
                  tooltip="Settings"
                  className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                >
                  <Settings className="size-4 text-muted-foreground" />
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-medium">Settings</span>
                  </div>
                  <ChevronUp className="ml-auto size-4 text-muted-foreground" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side="top"
                align="end"
                className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
                sideOffset={4}
              >
                <DropdownMenuItem
                  onClick={() => router.push("/settings")}
                  className="rounded-lg"
                >
                  <span>General</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => router.push("/settings/github")}
                  className="rounded-lg"
                >
                  <GitBranch className="size-3.5 mr-2 text-muted-foreground" />
                  <span>GitHub & Pull Requests</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => router.push("/settings/agent")}
                  className="rounded-lg"
                >
                  <Bot className="size-3.5 mr-2 text-muted-foreground" />
                  <span>Agent</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => router.push("/settings/integrations")}
                  className="rounded-lg"
                >
                  <Blocks className="size-3.5 mr-2 text-muted-foreground" />
                  <span>Integrations</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => router.push("/automations")}
                  className="rounded-lg"
                >
                  <Workflow className="size-3.5 mr-2 text-muted-foreground" />
                  <span>Automations</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => router.push("/stats")}
                  className="rounded-lg"
                >
                  <ChartColumnBig className="size-3.5 mr-2 text-muted-foreground" />
                  <span>Stats</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() => router.push("/environments")}
                  className="rounded-lg"
                >
                  <Container className="size-3.5 mr-2 text-muted-foreground" />
                  <span>Environments</span>
                </DropdownMenuItem>
                {isAdmin && (
                  <>
                    <DropdownMenuItem
                      onClick={() => router.push("/internal/admin")}
                      className="rounded-lg"
                    >
                      <Shield className="size-3.5 mr-2 text-muted-foreground" />
                      <span>Admin Panel</span>
                    </DropdownMenuItem>
                  </>
                )}
                {mounted && (
                  <DropdownMenuItem
                    onSelect={(e) => {
                      e.preventDefault();
                      setTheme(resolvedTheme === "light" ? "dark" : "light");
                    }}
                    className="rounded-lg"
                  >
                    <ThemeToggle resolvedTheme={resolvedTheme} />
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem
                  onClick={() => signOut()}
                  className="rounded-lg"
                >
                  <LogOut className="size-3.5 mr-2 text-muted-foreground" />
                  <span>Sign out</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>

          {/* User account */}
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" tooltip={user?.name ?? "Account"}>
              <Avatar className="size-7 rounded-md">
                <AvatarImage src={user?.image ?? undefined} />
                <AvatarFallback className="rounded-md bg-[var(--warm-stone)] text-foreground text-xs font-semibold">
                  {user?.name?.charAt(0) ?? "?"}
                </AvatarFallback>
              </Avatar>
              <div className="grid flex-1 text-left text-sm leading-tight">
                <span className="truncate font-medium">
                  {user?.name ?? "Account"}
                </span>
              </div>
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
  icon: React.ReactNode;
  isActive: boolean;
}) {
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={isActive} tooltip={title}>
        <Link
          href={href}
          className="font-normal text-xs transition-colors duration-150"
        >
          {icon}
          <span>{title}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

function ThemeToggle({ resolvedTheme }: { resolvedTheme: string | undefined }) {
  return (
    <span className="flex w-full items-center gap-2 text-sm text-muted-foreground">
      {resolvedTheme === "light" ? "Light Mode" : "Dark Mode"}
      {resolvedTheme === "light" ? (
        <SunIcon className="size-4 text-foreground/55" />
      ) : (
        <MoonIcon className="size-4 text-foreground/55" />
      )}
    </span>
  );
}
