"use client";

import { publicDocsUrl } from "@terragon/env/next-public";
import { useAtomValue } from "jotai";
import {
  BookOpen,
  ChartColumnBig,
  ChevronUp,
  Container,
  Home,
  MoonIcon,
  Settings,
  Shield,
  SunIcon,
  Workflow,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useTheme } from "next-themes";
import React, { useCallback, useEffect, useState } from "react";
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
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { headerClassName } from "./shared/header";
import { Wordmark, WordmarkLogo } from "./shared/wordmark";

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
    <Sidebar collapsible="icon" variant="inset" className="bg-app-background">
      <SidebarHeader
        className={cn(
          "justify-center p-2 group-data-[collapsible=icon]:px-2",
          headerClassName,
        )}
      >
        <SidebarHeaderContent />
      </SidebarHeader>
      <SidebarContent className="px-2 pb-4 pt-0 group-data-[collapsible=icon]:px-1.5">
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
                title="Stats"
                href="/stats"
                icon={<ChartColumnBig className="h-3.5 w-3.5" />}
              />
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup className="mt-1">
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
          <SidebarGroup className="mt-2">
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

        <SidebarGroup className="mt-auto pt-0.5">
          <SidebarGroupLabel className="mb-1 px-3">Support</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <Item
                title="Documentation"
                href={publicDocsUrl()}
                icon={<BookOpen className="h-3.5 w-3.5" />}
                external
              />
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="sidebar-footer-pwa border-t border-sidebar-border/70 px-3 pb-3 pt-3 group-data-[collapsible=icon]:px-1.5">
        <SidebarMenu>
          <AppMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton
                  size="lg"
                  tooltip={user?.name ?? "Account"}
                  className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
                >
                  <Avatar className="h-8 w-8 rounded-lg">
                    <AvatarImage src={user?.image ?? undefined} />
                    <AvatarFallback className="rounded-lg bg-[var(--warm-stone)] text-foreground text-xs font-semibold">
                      {user?.name.charAt(0)}
                    </AvatarFallback>
                  </Avatar>
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-medium">{user?.name}</span>
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
  external = false,
}: {
  title: string;
  href: string;
  icon: React.ReactNode;
  count?: number;
  external?: boolean;
}) {
  const pathname = usePathname();
  const isActive = pathname === href;

  return (
    <AppMenuItem>
      <SidebarMenuButton asChild isActive={isActive} tooltip={title}>
        {external ? (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="font-normal text-xs transition-colors duration-150"
          >
            {icon}
            <span>{title}</span>
          </a>
        ) : (
          <Link
            href={href}
            className="font-normal text-xs transition-colors duration-150"
          >
            {icon}
            <span>{title}</span>
          </Link>
        )}
      </SidebarMenuButton>
      {!!count && (
        <SidebarMenuBadge className="right-2 rounded-full border border-sidebar-border/60 bg-[var(--warm-stone)] px-1.5 text-[10px] font-semibold text-foreground">
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
