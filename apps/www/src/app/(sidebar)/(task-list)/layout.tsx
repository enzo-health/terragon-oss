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
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-0 md:py-1.5 md:pr-1.5 md:pl-0.5">
      <div className="flex min-h-0 flex-1 overflow-hidden bg-background transition-[border-radius,box-shadow] duration-200 md:rounded-lg md:border md:border-hairline md:shadow-xs">
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
