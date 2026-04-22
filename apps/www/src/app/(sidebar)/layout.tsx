import { AppSidebar } from "@/components/app-sidebar";
import { NotificationProvider } from "@/components/system/notification-provider";
import { SidebarInset } from "@/components/ui/sidebar";
import { SidebarAuthWrapper } from "@/components/sidebar-auth-wrapper";

// Note: Removed force-dynamic - auth is now handled by client component wrapper
// This allows static optimization and prefetching for the layout shell
export default function SidebarLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <SidebarAuthWrapper>
        <NotificationProvider />
        <AppSidebar />
      </SidebarAuthWrapper>
      <SidebarInset className="!m-0 !overflow-hidden !rounded-none !shadow-none max-h-svh min-w-0 bg-app-background">
        {children}
      </SidebarInset>
    </>
  );
}
