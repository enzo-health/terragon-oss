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
          className="size-7 text-muted-foreground"
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
    <Sidebar collapsible="icon" className="bg-background border-r">
      <SidebarHeader
        className={cn(
          "p-4 pb-2 justify-center group-data-[collapsible=icon]:p-2",
          headerClassName,
        )}
      >
        <SidebarHeaderContent />
      </SidebarHeader>
      <SidebarContent className="px-2 group-data-[collapsible=icon]:px-1.5">
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
              <Item
                title="Home"
                href="/dashboard"
                icon={<Home className="h-4 w-4" />}
              />
              <Item
                title="Automations"
                href="/automations"
                icon={<Workflow className="h-4 w-4" />}
              />
              <Item
                title="Stats"
                href="/stats"
                icon={<ChartColumnBig className="h-4 w-4" />}
              />
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup className="mt-4">
          <SidebarGroupLabel className="uppercase tracking-[0.6px] text-[10px] font-semibold text-muted-foreground/50 mb-1 px-3">
            Configure
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
              <Item
                title="Environments"
                href="/environments"
                icon={<Container className="h-4 w-4" />}
              />
              <Item
                title="Settings"
                href="/settings"
                icon={<Settings className="h-4 w-4" />}
              />
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        {isAdmin && (
          <SidebarGroup className="mt-8">
            <SidebarGroupLabel className="uppercase tracking-[0.6px] text-[10px] font-semibold text-muted-foreground/50 mb-1 px-3">
              Admin
            </SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu className="gap-0.5">
                <Item
                  title="Admin Panel"
                  href="/internal/admin"
                  icon={<Shield className="h-4 w-4" />}
                />
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}

        <SidebarGroup className="mt-4">
          <SidebarGroupLabel className="uppercase tracking-[0.6px] text-[10px] font-semibold text-muted-foreground/50 mb-1 px-3">
            Support
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="gap-0.5">
              <AppMenuItem>
                <SidebarMenuButton
                  asChild
                  tooltip="Documentation"
                  className="font-sans font-medium text-caption rounded-lg h-8 px-3"
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
      <SidebarFooter className="sidebar-footer-pwa p-3 border-t">
        <SidebarMenu>
          <AppMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton
                  tooltip={user?.name ?? "Account"}
                  className="group-data-[collapsible=icon]:justify-center h-10 rounded-lg hover:bg-accent transition-colors"
                >
                  <Avatar className="size-7 group-data-[collapsible=icon]:mr-0 mr-3 shadow-card">
                    <AvatarImage src={user?.image ?? undefined} />
                    <AvatarFallback className="bg-[var(--warm-stone)] text-foreground text-xs font-bold">
                      {user?.name.charAt(0)}
                    </AvatarFallback>
                  </Avatar>
                  <span className="group-data-[collapsible=icon]:hidden font-sans font-medium text-caption">
                    {user?.name}
                  </span>
                  <ChevronUp className="ml-auto group-data-[collapsible=icon]:hidden size-4 opacity-50" />
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
        className={cn(
          "font-sans font-medium text-caption rounded-lg h-8 px-3 transition-colors group-data-[collapsible=icon]:justify-center",
          isActive ? "bg-accent" : "hover:bg-accent/50",
        )}
      >
        <Link href={href}>
          <span
            className={cn(
              "transition-colors",
              isActive ? "text-foreground" : "text-muted-foreground/60",
            )}
          >
            {icon}
          </span>
          <span>{title}</span>
        </Link>
      </SidebarMenuButton>
      {!!count && (
        <SidebarMenuBadge className="bg-[var(--warm-stone)] text-foreground rounded-full font-bold text-[10px]">
          {count}
        </SidebarMenuBadge>
      )}
    </AppMenuItem>
  );
}

function ThemeToggle({ resolvedTheme }: { resolvedTheme: string | undefined }) {
  return (
    <span className="text-sm text-muted-foreground flex items-center gap-2 w-full">
      {resolvedTheme === "light" ? "Light Mode" : "Dark Mode"}
      {resolvedTheme === "light" ? (
        <SunIcon className="size-4 text-foreground/50" />
      ) : (
        <MoonIcon className="size-4 text-foreground/50" />
      )}
    </span>
  );
}
