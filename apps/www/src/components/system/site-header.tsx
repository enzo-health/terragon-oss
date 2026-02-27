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
import { headerClassName } from "../shared/header";

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
    <div className={cn("flex flex-col w-full px-4", headerClassName)}>
      <div
        className={cn(
          "flex w-full items-center justify-between h-full",
          isConstrainedPage && "max-w-4xl",
        )}
      >
        <div className="flex gap-2 items-center min-w-0">
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
        <div className="ml-4">
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
      <BreadcrumbList className="text-lg text-foreground flex-nowrap">
        {breadcrumbs.map((item, index) => (
          <React.Fragment key={index}>
            {index > 0 && <BreadcrumbSeparator />}
            <BreadcrumbItem
              className={cn("truncate block", index === 0 && "font-bold")}
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
