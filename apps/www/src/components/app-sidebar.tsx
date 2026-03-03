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

  return (
    <>
      <Sidebar collapsible="icon">
        <SidebarHeader className={cn("p-4 justify-center", headerClassName)}>
          <SidebarHeaderContent />
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent>
              <SidebarMenu>
                <Item
                  title="Home"
                  href="/dashboard"
                  icon={<Home className="h-5 w-5" />}
                />
                <Item
                  title="Automations"
                  href="/automations"
                  icon={<Workflow className="h-5 w-5" />}
                />
                <Item
                  title="Stats"
                  href="/stats"
                  icon={<ChartColumnBig className="h-5 w-5" />}
                />
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          <SidebarGroup>
            <SidebarGroupLabel>Configure</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <Item
                  title="Environments"
                  href="/environments"
                  icon={<Container className="h-5 w-5" />}
                />
                <Item
                  title="Settings"
                  href="/settings"
                  icon={<Settings className="h-5 w-5" />}
                />
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
          {isAdmin && (
            <SidebarGroup>
              <SidebarGroupLabel>Admin</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  <Item
                    title="Admin Panel"
                    href="/internal/admin"
                    icon={<Shield className="h-5 w-5" />}
                  />
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          )}

          <SidebarGroup>
            <SidebarGroupLabel>Support</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                <AppMenuItem>
                  <SidebarMenuButton asChild tooltip="Documentation">
                    <a
                      href={publicDocsUrl()}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <BookOpen className="h-5 w-5" />
                      <span>Documentation</span>
                    </a>
                  </SidebarMenuButton>
                </AppMenuItem>
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter className="sidebar-footer-pwa">
          <SidebarMenu>
            <AppMenuItem>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <SidebarMenuButton
                    tooltip={user?.name ?? "Account"}
                    className="group-data-[collapsible=icon]:justify-center"
                  >
                    <Avatar className="size-6 group-data-[collapsible=icon]:mr-0 mr-2">
                      <AvatarImage src={user?.image ?? undefined} />
                      <AvatarFallback>{user?.name.charAt(0)}</AvatarFallback>
                    </Avatar>
                    <span className="group-data-[collapsible=icon]:hidden">
                      {user?.name}
                    </span>
                    <ChevronUp className="ml-auto group-data-[collapsible=icon]:hidden" />
                  </SidebarMenuButton>
                </DropdownMenuTrigger>
                <DropdownMenuContent
                  side="top"
                  align="start"
                  alignOffset={1}
                  className="w-(--radix-popper-anchor-width)"
                >
                  <DropdownMenuItem asChild>
                    <ThemeToggle />
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => signOut()}>
                    <span>Sign out</span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </AppMenuItem>
          </SidebarMenu>
        </SidebarFooter>
        <SidebarRail />
      </Sidebar>
    </>
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
  const { isMobile, setOpenMobile } = useSidebar();

  const handleClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
  }, [isMobile, setOpenMobile]);

  return (
    <AppMenuItem>
      <SidebarMenuButton asChild isActive={isActive} tooltip={title}>
        <Link href={href} onClick={handleClick}>
          {icon}
          <span>{title}</span>
        </Link>
      </SidebarMenuButton>
      {!!count && (
        <SidebarMenuBadge className="bg-muted">{count}</SidebarMenuBadge>
      )}
    </AppMenuItem>
  );
}

function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) {
    return null;
  }

  return (
    <div
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (resolvedTheme === "light") {
          setTheme("dark");
        } else {
          setTheme("light");
        }
      }}
      className="text-sm text-muted-foreground hover:text-foreground transition-colors p-2 flex items-center gap-2 hover:bg-accent rounded-md cursor-pointer"
      aria-label="Toggle theme"
    >
      {resolvedTheme === "light" ? "Light Mode" : "Dark Mode"}
      {resolvedTheme === "light" ? (
        <SunIcon className="size-4 text-foreground/50" />
      ) : (
        <MoonIcon className="size-4 text-foreground/50" />
      )}
    </div>
  );
}
