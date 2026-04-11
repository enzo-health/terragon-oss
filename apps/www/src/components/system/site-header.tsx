"use client";

import { useAtomValue } from "jotai";
import { userAtom } from "@/atoms/user";
import React, { memo } from "react";
import { useSidebar, SidebarTrigger } from "@/components/ui/sidebar";
import { usePageHeader } from "@/contexts/page-header";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { cn } from "@/lib/utils";
import { usePathname } from "next/navigation";
import { Wordmark } from "../shared/wordmark";
import { headerClassName, headerSurfaceClassName } from "../shared/header";

export const SiteHeader = memo(function SiteHeader() {
  const pathname = usePathname();
  const user = useAtomValue(userAtom);
  const { open: isSidebarOpen, isMobile } = useSidebar();
  const isConstrainedPage =
    pathname === "/automations" ||
    pathname.startsWith("/automations/") ||
    pathname === "/environments" ||
    pathname.startsWith("/environments/");

  if (!user) {
    return null;
  }
  return (
    <div
      className={cn(
        "flex w-full items-center px-4 md:px-5",
        headerClassName,
        headerSurfaceClassName,
      )}
    >
      <div
        className={cn(
          "flex h-full w-full items-center justify-between gap-4",
          isConstrainedPage && "mx-auto max-w-4xl",
        )}
      >
        <div className="flex min-w-0 items-center gap-2.5">
          {isMobile && <SidebarTrigger className="px-0 size-auto w-fit" />}
          {pathname === "/dashboard" && (
            <div
              className={cn(
                "block md:hidden",
                isSidebarOpen && "!hidden",
                (!isSidebarOpen || isMobile) && "!block",
              )}
            >
              <Wordmark
                href="/dashboard"
                showLogo={isSidebarOpen || isMobile}
              />
            </div>
          )}
          <SiteHeaderBreadcrumbs />
        </div>
        <div className="ml-2 md:ml-4">
          <SiteHeaderNav />
        </div>
      </div>
    </div>
  );
});

const SiteHeaderNav = memo(function SiteHeaderNav() {
  const { setHeaderActionContainer } = usePageHeader();

  return (
    <div
      className="flex items-center gap-2 sm:gap-2.5"
      ref={(el) => setHeaderActionContainer(el)}
    />
  );
});

const SiteHeaderBreadcrumbs = memo(function SiteHeaderBreadcrumbs() {
  const pathname = usePathname();
  const { breadcrumbs } = usePageHeader();
  if (pathname === "/dashboard" || breadcrumbs.length === 0) {
    return null;
  }
  return (
    <Breadcrumb className="min-w-0 overflow-hidden">
      <BreadcrumbList className="text-sm text-foreground/88 flex-nowrap tracking-[-0.01em] md:text-[15px]">
        {breadcrumbs.map((item, index) => (
          <React.Fragment key={index}>
            {index > 0 && <BreadcrumbSeparator />}
            <BreadcrumbItem
              className={cn(
                "block truncate",
                index === breadcrumbs.length - 1
                  ? "font-semibold text-foreground"
                  : "text-muted-foreground",
              )}
            >
              {item.href ? (
                <BreadcrumbLink href={item.href}>{item.label}</BreadcrumbLink>
              ) : (
                item.label
              )}
            </BreadcrumbItem>
          </React.Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
});
