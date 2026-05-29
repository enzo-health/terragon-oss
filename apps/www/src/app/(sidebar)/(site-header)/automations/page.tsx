import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import type { Metadata } from "next";
import { Automations } from "@/components/automations/main";
import { getUserIdOrRedirect } from "@/lib/auth-server";
import { getOrCreateQueryClient } from "@/lib/query-client";
import {
  automationQueryOptions,
  hasReachedLimitOfAutomationsQueryOptions,
} from "@/queries/automation-queries";

export const metadata: Metadata = {
  title: "Automations | Terragon",
};

export default async function AutomationsPage() {
  await getUserIdOrRedirect();
  const queryClient = getOrCreateQueryClient();
  await Promise.all([
    queryClient.prefetchQuery(automationQueryOptions()),
    queryClient.prefetchQuery(hasReachedLimitOfAutomationsQueryOptions()),
  ]);
  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <div className="flex flex-col justify-start h-full w-full max-w-4xl">
        <Automations />
      </div>
    </HydrationBoundary>
  );
}
