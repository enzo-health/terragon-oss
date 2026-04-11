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
      {userId ? <ThreadListSidebar /> : null}
      <div className="flex flex-col h-full min-w-0 flex-1 items-center">
        <BannerContainer />
        <PageHeaderProvider>{children}</PageHeaderProvider>
      </div>
    </HydrationBoundary>
  );
}
