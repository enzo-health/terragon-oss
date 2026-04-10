import { getUserIdOrRedirect } from "@/lib/auth-server";
import { getAutomation } from "@leo/shared/model/automations";
import { db } from "@/lib/db";
import { notFound } from "next/navigation";
import { AutomationContent } from "@/components/automations/content";
import {
  dehydrate,
  HydrationBoundary,
  QueryClient,
} from "@tanstack/react-query";
import { automationDetailQueryOptions } from "@/queries/automation-queries";
import { threadListQueryOptions } from "@/queries/thread-queries";

export default async function AutomationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const userId = await getUserIdOrRedirect();
  const { id } = await params;
  const automation = await getAutomation({
    db,
    automationId: id,
    userId,
  });
  if (!automation) {
    notFound();
  }
  const queryClient = new QueryClient();
  await Promise.all([
    queryClient.prefetchQuery(automationDetailQueryOptions(id)),
    queryClient.prefetchInfiniteQuery(
      threadListQueryOptions({ automationId: id }),
    ),
  ]);
  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <div className="flex flex-col justify-start h-full w-full max-w-4xl">
        <AutomationContent automationId={id} />
      </div>
    </HydrationBoundary>
  );
}
