import { dehydrate, HydrationBoundary } from "@tanstack/react-query";
import type { Metadata } from "next";
import { AgentSettings } from "@/components/settings/tab/agent";
import { getUserIdOrRedirect } from "@/lib/auth-server";
import { getOrCreateQueryClient } from "@/lib/query-client";
import { credentialsQueryOptions } from "@/queries/credentials-queries";

export const metadata: Metadata = {
  title: "Agent Settings | Terragon",
};

export default async function AgentSettingsPage() {
  await getUserIdOrRedirect();
  const queryClient = getOrCreateQueryClient();
  await queryClient.prefetchQuery(credentialsQueryOptions());
  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <AgentSettings />
    </HydrationBoundary>
  );
}
