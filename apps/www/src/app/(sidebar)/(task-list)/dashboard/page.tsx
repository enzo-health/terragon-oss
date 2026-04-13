import {
  dehydrate,
  HydrationBoundary,
  QueryClient,
} from "@tanstack/react-query";
import type { Metadata } from "next";
import { Dashboard } from "@/components/dashboard";
import { getUserInfoOrRedirect } from "@/lib/auth-server";
import { threadListQueryOptions } from "@/queries/thread-queries";

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
      <Dashboard showArchived={showArchived} />
    </HydrationBoundary>
  );
}
