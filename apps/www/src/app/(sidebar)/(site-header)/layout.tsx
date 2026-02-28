import { SiteHeader } from "@/components/system/site-header";
import { BannerContainer } from "@/components/system/banner-container";
import { PageHeaderProvider } from "@/contexts/page-header";
import {
  dehydrate,
  HydrationBoundary,
  QueryClient,
} from "@tanstack/react-query";

export default async function SiteHeaderLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const queryClient = new QueryClient();
  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <div className="flex flex-col h-[100dvh] min-w-0 w-full items-center">
        <BannerContainer />
        <PageHeaderProvider>
          <SiteHeader />
          <div className="flex-1 w-full px-4 overflow-auto">{children}</div>
        </PageHeaderProvider>
      </div>
    </HydrationBoundary>
  );
}
