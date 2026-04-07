import { BannerContainer } from "@/components/system/banner-container";
import { PageFrame } from "@/components/system/page-frame";
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
        <PageFrame>{children}</PageFrame>
      </PageHeaderProvider>
    </div>
  );
}
