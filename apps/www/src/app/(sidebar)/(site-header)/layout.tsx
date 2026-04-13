import { BannerContainer } from "@/components/system/banner-container";
import { PageFrame } from "@/components/system/page-frame";
import { PageHeaderProvider } from "@/contexts/page-header";

export default async function SiteHeaderLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <BannerContainer />
      <PageHeaderProvider>
        <PageFrame>{children}</PageFrame>
      </PageHeaderProvider>
    </div>
  );
}
