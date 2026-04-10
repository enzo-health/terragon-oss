import { AgentSettings } from "@/components/settings/tab/agent";
import { getUserIdOrRedirect } from "@/lib/auth-server";
import type { Metadata } from "next";
import {
  HydrationBoundary,
  QueryClient,
  dehydrate,
} from "@tanstack/react-query";
import { credentialsQueryOptions } from "@/queries/credentials-queries";

export const metadata: Metadata = {
  title: "Agent Settings | Leo",
};

export default async function AgentSettingsPage() {
  await getUserIdOrRedirect();
  const queryClient = new QueryClient();
  await queryClient.prefetchQuery(credentialsQueryOptions());
  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <AgentSettings />
    </HydrationBoundary>
  );
}
