import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import { getAutomation } from "@terragon/shared/model/automations";
import { notFound } from "next/navigation";
import { AutomationContent } from "@/components/automations/content";
import { getUserIdOrRedirect } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { getOrCreateQueryClient } from "@/lib/query-client";
import { automationDetailQueryOptions } from "@/queries/automation-queries";
import { threadListQueryOptions } from "@/queries/thread-queries";

export const metadata = {
  title: "Automation",
};

export default async function AutomationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const queryClient = getOrCreateQueryClient();
  const userId = await getUserIdOrRedirect();
  const automationPromise = getAutomation({
    db,
    automationId: id,
    userId,
  });
  const prefetchPromise = Promise.all([
    queryClient.prefetchQuery(automationDetailQueryOptions(id)),
    queryClient.prefetchInfiniteQuery(
      threadListQueryOptions({ automationId: id }),
    ),
  ]);
  const [automation] = await Promise.all([automationPromise, prefetchPromise]);
  if (!automation) {
    notFound();
  }
  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <div className="flex flex-col justify-start h-full w-full max-w-4xl">
        <AutomationContent automationId={id} />
      </div>
    </HydrationBoundary>
  );
}
