import { SiteHeader } from "@/components/system/site-header";
import { BannerContainer } from "@/components/system/banner-container";
import { PageHeaderProvider } from "@/contexts/page-header";

export default async function SiteHeaderLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col h-[100dvh] min-w-0 w-full items-center">
      <BannerContainer />
      <PageHeaderProvider>
        <SiteHeader />
        <div className="flex-1 w-full px-4 overflow-auto">{children}</div>
      </PageHeaderProvider>
    </div>
  );
}
