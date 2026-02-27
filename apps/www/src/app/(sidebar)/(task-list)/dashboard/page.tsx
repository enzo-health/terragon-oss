import { getUserInfoOrRedirect } from "@/lib/auth-server";
import { Dashboard } from "@/components/dashboard";
import type { Metadata } from "next";
import { SiteHeader } from "@/components/system/site-header";
import { threadListQueryOptions } from "@/queries/thread-queries";
import {
  dehydrate,
  HydrationBoundary,
  QueryClient,
} from "@tanstack/react-query";

export const metadata: Metadata = {
  title: "Dashboard | Terragon",
};

export const maxDuration = 800;

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{
    archived?: string;
  }>;
}) {
  await getUserInfoOrRedirect();
  // Get the archived param
  const params = await searchParams;
  const queryClient = new QueryClient();
  const showArchived = params.archived === "true";
  // If archived is true, prefetch the archived threads otherwise do nothing
  // because active threads are prefetched by the task sidebar already.
  if (showArchived) {
    await queryClient.prefetchInfiniteQuery(
      threadListQueryOptions({ archived: showArchived }),
    );
  }
  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <SiteHeader />
      <div className="flex-1 w-full px-4 overflow-auto">
        <Dashboard showArchived={showArchived} />
      </div>
    </HydrationBoundary>
  );
}
