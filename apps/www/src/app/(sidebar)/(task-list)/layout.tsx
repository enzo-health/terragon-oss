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
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-0 md:py-2 md:pr-2 md:pl-1">
        {/* Outer frame: canvas-toned (was bg-card, which made every inner
            child render on cream-strong and made surfaces inside —
            especially the prompt box, which also uses bg-card — invisible
            against their parent. The hairline border + rounded corners
            still produce the framed-card look without flooding the inside
            with cream-strong. */}
        <div className="flex min-h-0 flex-1 overflow-hidden bg-background transition-[border-radius,box-shadow] duration-200 md:rounded-[10px] md:border md:border-hairline md:shadow-sm">
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
        <div className="h-[52px] px-2.5 py-1.5" />
        <div className="space-y-3 px-4 py-4">
          <div className="h-3 w-20 rounded bg-muted" />
          <div className="h-12 rounded-lg bg-muted/70" />
          <div className="h-12 rounded-lg bg-muted/50" />
          <div className="h-12 rounded-lg bg-muted/40" />
        </div>
      </div>
    </div>
  );
}
