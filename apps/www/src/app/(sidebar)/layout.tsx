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
    <>
      {userId ? (
        <>
          <NotificationProvider />
          <AppSidebar />
        </>
      ) : null}
      <SidebarInset className="!m-0 !overflow-hidden !rounded-none !shadow-none max-h-svh min-w-0 bg-app-background">
        {children}
      </SidebarInset>
    </>
  );
}
