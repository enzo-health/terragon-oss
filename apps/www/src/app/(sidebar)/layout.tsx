import { AppSidebar } from "@/components/app-sidebar";
import { NotificationProvider } from "@/components/system/notification-provider";
import { SidebarInset } from "@/components/ui/sidebar";
import { getUserIdOrNull } from "@/lib/auth-server";

export const dynamic = "force-dynamic";

export default async function SidebarLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const userId = await getUserIdOrNull();
  return (
    <div
      className="group/sidebar-wrapper has-data-[variant=inset]:bg-sidebar flex min-h-svh w-full"
      style={
        {
          "--sidebar-width": "16rem",
          "--sidebar-width-mobile": "16rem",
        } as React.CSSProperties
      }
    >
      {userId ? (
        <>
          <NotificationProvider />
          <AppSidebar />
        </>
      ) : null}
      <SidebarInset className="!flex-row overflow-hidden">
        {children}
      </SidebarInset>
    </div>
  );
}
