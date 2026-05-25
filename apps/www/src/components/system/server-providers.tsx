import { Providers } from "./providers";
import { SidebarProvider } from "../ui/sidebar";
import { cookies } from "next/headers";
import {
  PlatformProvider,
  PLATFORM_COOKIE,
  type Platform,
} from "@/hooks/use-platform";

export async function ServerProviders({
  children,
}: {
  children: React.ReactNode;
}) {
  const cookieStore = await cookies();
  const sidebarCookie = cookieStore.get("sidebar_state");
  const isSidebarOpenCookie = sidebarCookie && sidebarCookie?.value === "true";
  const platformCookie = cookieStore.get(PLATFORM_COOKIE)?.value;
  const initialPlatform: Platform =
    platformCookie === "mobile" || platformCookie === "desktop"
      ? platformCookie
      : "unknown";
  return (
    <PlatformProvider initial={initialPlatform}>
      <SidebarProvider defaultOpen={isSidebarOpenCookie}>
        <Providers>{children}</Providers>
      </SidebarProvider>
    </PlatformProvider>
  );
}
