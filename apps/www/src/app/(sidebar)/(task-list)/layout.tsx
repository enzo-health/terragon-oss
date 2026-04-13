import { BannerContainer } from "@/components/system/banner-container";
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
  const userId = await getUserIdOrNull();
  const queryClient = new QueryClient();
  await queryClient.prefetchInfiniteQuery(
    threadListQueryOptions({ archived: false }),
  );
  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden p-0 md:py-4 md:pr-4 md:pl-2">
        <div className="flex min-h-0 flex-1 overflow-hidden bg-card transition-[border-radius,box-shadow] duration-200 md:rounded-[10px] md:border md:border-border md:shadow-sm">
          {userId ? <ThreadListSidebar /> : null}
          <div className="flex flex-col h-full min-w-0 flex-1">
            <BannerContainer />
            <PageHeaderProvider>{children}</PageHeaderProvider>
          </div>
        </div>
      </div>
    </HydrationBoundary>
  );
}
