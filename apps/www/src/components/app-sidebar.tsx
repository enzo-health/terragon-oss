"use client";

import {
  Home,
  Settings,
  Container,
  BookOpen,
  Shield,
  ChevronUp,
  Workflow,
  ChartColumnBig,
  GitPullRequestArrow,
  SunIcon,
  MoonIcon,
} from "lucide-react";
import { Wordmark, WordmarkLogo } from "./shared/wordmark";
import {
  useSidebar,
  Sidebar,
  SidebarTrigger,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarHeader,
  SidebarMenuBadge,
  SidebarFooter,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useAtomValue } from "jotai";
import { userAtom } from "@/atoms/user";
import { publicDocsUrl } from "@terragon/env/next-public";
import {
  DropdownMenu,
  DropdownMenuItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { signOut } from "@/components/auth";
import Link from "next/link";
import React from "react";
import { useTheme } from "next-themes";
import { headerClassName } from "./shared/header";
import { cn } from "@/lib/utils";

function SidebarHeaderContent() {
  const { open, isMobile, toggleSidebar } = useSidebar();
  if (!open && !isMobile) {
    return (
      <div className="flex items-center justify-center">
        <Button
          variant="ghost"
          size="icon"
          onClick={toggleSidebar}
          className="size-9 rounded-xl border border-border/70 bg-background/90 text-foreground shadow-[var(--shadow-outline-ring)] hover:bg-accent/80"
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

function AppMenuItem({
  children,
  onClick,
  ...props
}: React.ComponentProps<"li">) {
  const { isMobile, setOpenMobile } = useSidebar();

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLLIElement>) => {
      if (isMobile) {
        setOpenMobile(false);
      }
      onClick?.(e);
    },
    [isMobile, setOpenMobile, onClick],
  );

  return (
    <SidebarMenuItem onClick={handleClick} {...props}>
      {children}
    </SidebarMenuItem>
  );
}

export function AppSidebar() {
  const user = useAtomValue(userAtom);
  const isAdmin = user?.role === "admin";
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  return (
    <Sidebar collapsible="icon" variant="inset">
      <SidebarHeader
        className={cn(
          "justify-center px-3 pb-2 pt-3 group-data-[collapsible=icon]:px-2 group-data-[collapsible=icon]:pt-3",
          headerClassName,
        )}
      >
        <SidebarHeaderContent />
      </SidebarHeader>
      <SidebarContent className="px-2.5 pb-3 group-data-[collapsible=icon]:px-2">
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <Item
                title="Home"
                href="/dashboard"
                icon={<Home className="h-3.5 w-3.5" />}
              />
              <Item
                title="Automations"
                href="/automations"
                icon={<Workflow className="h-3.5 w-3.5" />}
              />
              <Item
                title="Reviews"
                href="/reviews"
                icon={<GitPullRequestArrow className="h-4 w-4" />}
              />
              <Item
                title="Stats"
                href="/stats"
                icon={<ChartColumnBig className="h-3.5 w-3.5" />}
              />
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup className="mt-3">
          <SidebarGroupLabel className="mb-1 px-3">Configure</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <Item
                title="Environments"
                href="/environments"
                icon={<Container className="h-3.5 w-3.5" />}
              />
              <Item
                title="Settings"
                href="/settings"
                icon={<Settings className="h-3.5 w-3.5" />}
              />
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        {isAdmin && (
          <SidebarGroup className="mt-6">
            <SidebarGroupLabel className="mb-1 px-3">Admin</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <Item
                  title="Admin Panel"
                  href="/internal/admin"
                  icon={<Shield className="h-3.5 w-3.5" />}
                />
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        <SidebarGroup className="mt-auto pt-2">
          <SidebarGroupLabel className="mb-1 px-3">Support</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <AppMenuItem>
                <SidebarMenuButton
                  asChild
                  tooltip="Documentation"
                  className="text-caption"
                >
                  <a
                    href={publicDocsUrl()}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <BookOpen className="h-5 w-5 opacity-70" />
                    <span>Documentation</span>
                  </a>
                </SidebarMenuButton>
              </AppMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="sidebar-footer-pwa border-t border-sidebar-border/70 px-3 pb-3 pt-3">
        <SidebarMenu>
          <AppMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton
                  tooltip={user?.name ?? "Account"}
                  className="h-11 rounded-2xl bg-background/70 shadow-[var(--shadow-outline-ring)] group-data-[collapsible=icon]:rounded-full group-data-[collapsible=icon]:justify-center hover:bg-accent/85"
                >
                  <Avatar className="mr-3 size-7 shadow-[var(--shadow-card)] group-data-[collapsible=icon]:mr-0">
                    <AvatarImage src={user?.image ?? undefined} />
                    <AvatarFallback className="bg-[var(--warm-stone)] text-foreground text-xs font-semibold">
                      {user?.name.charAt(0)}
                    </AvatarFallback>
                  </Avatar>
                  <span className="text-caption font-medium group-data-[collapsible=icon]:hidden">
                    {user?.name}
                  </span>
                  <ChevronUp className="ml-auto size-4 opacity-40 group-data-[collapsible=icon]:hidden" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side="top"
                align="start"
                alignOffset={1}
                className="w-(--radix-popper-anchor-width) rounded-xl shadow-card"
              >
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
                  <span>Sign out</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </AppMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  );
}

function Item({
  title,
  href,
  icon,
  count,
}: {
  title: string;
  href: string;
  icon: React.ReactNode;
  count?: number;
}) {
  const pathname = usePathname();
  const isActive = pathname === href;

  return (
    <AppMenuItem>
      <SidebarMenuButton
        asChild
        isActive={isActive}
        tooltip={title}
        className="text-caption"
      >
        <Link href={href}>
          <span
            className={cn(
              "transition-colors",
              isActive ? "text-primary" : "text-muted-foreground/70",
            )}
          >
            {icon}
          </span>
          <span>{title}</span>
        </Link>
      </SidebarMenuButton>
      {!!count && (
        <SidebarMenuBadge className="rounded-full bg-[var(--warm-stone)] px-1.5 text-[10px] font-semibold text-foreground">
          {count}
        </SidebarMenuBadge>
      )}
    </AppMenuItem>
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
