import { Suspense } from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { NotificationProvider } from "@/components/system/notification-provider";
import { SidebarInset } from "@/components/ui/sidebar";
import { SidebarAuthWrapper } from "@/components/sidebar-auth-wrapper";
import { SidebarSkeleton } from "@/components/sidebar-skeleton";

// Note: Removed force-dynamic - auth is now handled by client component wrapper
// This allows static optimization and prefetching for the layout shell
export default function SidebarLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <Suspense fallback={<SidebarSkeleton />}>
        <SidebarAuthWrapper>
          <NotificationProvider />
          <AppSidebar />
        </SidebarAuthWrapper>
      </Suspense>
      <SidebarInset className="!m-0 !overflow-hidden !rounded-none !shadow-none max-h-svh min-w-0 bg-app-background">
        {children}
      </SidebarInset>
    </>
  );
}
