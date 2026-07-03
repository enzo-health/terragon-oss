import { Suspense } from "react";
import { BannerContainer } from "@/components/system/banner-container";
import { BannerSkeleton } from "@/components/system/banner-skeleton";
import { PageHeaderProvider } from "@/contexts/page-header";

export default async function TaskListLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-0">
      <div className="flex min-h-0 flex-1 overflow-hidden bg-background md:border-l md:border-hairline">
        <div className="flex flex-col h-full min-w-0 flex-1">
          <Suspense fallback={<BannerSkeleton />}>
            <BannerContainer />
          </Suspense>
          <PageHeaderProvider>{children}</PageHeaderProvider>
        </div>
      </div>
    </div>
  );
}
