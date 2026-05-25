import { Suspense } from "react";
import { BannerContainer } from "@/components/system/banner-container";
import { BannerSkeleton } from "@/components/system/banner-skeleton";
import { PageHeaderProvider } from "@/contexts/page-header";
import { ThreadListSidebar } from "@/components/thread-list/sidebar";
import {
  HydrationBoundary,
  QueryClient,
  dehydrate,
} from "@tanstack/react-query";
import { threadListQueryOptions } from "@/queries/thread-queries";
import { getUserIdOrNull } from "@/lib/auth-server";

export default async function TaskListLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const queryClient = new QueryClient();
  const userId = await getUserIdOrNull();
  if (userId) {
    await queryClient.prefetchInfiniteQuery(
      threadListQueryOptions({ archived: false }),
    );
  }
  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-0 md:py-1.5 md:pr-1.5 md:pl-0.5">
        {/* Outer frame: canvas-toned (was bg-card, which made every inner
            child render on cream-strong and made surfaces inside —
            especially the prompt box, which also uses bg-card — invisible
            against their parent. The hairline border + rounded corners
            still produce the framed-card look without flooding the inside
            with cream-strong. */}
        <div className="flex min-h-0 flex-1 overflow-hidden bg-background transition-[border-radius,box-shadow] duration-200 md:rounded-lg md:border md:border-hairline md:shadow-xs">
          {userId ? (
            <Suspense fallback={<ThreadListSidebarFallback />}>
              <ThreadListSidebar />
            </Suspense>
          ) : null}
          <div className="flex flex-col h-full min-w-0 flex-1">
            <Suspense fallback={<BannerSkeleton />}>
              <BannerContainer />
            </Suspense>
            <PageHeaderProvider>{children}</PageHeaderProvider>
          </div>
        </div>
      </div>
    </HydrationBoundary>
  );
}

function ThreadListSidebarFallback() {
  return (
    <div
      className="hidden md:flex sticky top-0 h-full border-r bg-background flex-shrink-0 z-20"
      style={{ width: "251px" }}
    >
      <div className="flex h-full w-full flex-col overflow-hidden">
        <div className="h-12 px-2 py-1" />
        <div className="flex flex-col gap-2 px-3 py-3">
          <div className="h-3 w-20 rounded bg-muted" />
          <div className="h-10 rounded-md bg-muted/70" />
          <div className="h-10 rounded-md bg-muted/50" />
          <div className="h-10 rounded-md bg-muted/40" />
        </div>
      </div>
    </div>
  );
}
