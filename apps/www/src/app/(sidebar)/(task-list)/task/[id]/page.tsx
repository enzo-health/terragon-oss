import ChatUI from "@/components/chat/chat-ui";
import { getUserIdOrNull, getUserIdOrRedirect } from "@/lib/auth-server";
import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import { getThreadDocumentTitle } from "@/agent/thread-utils";
import {
  HydrationBoundary,
  QueryClient,
  dehydrate,
} from "@tanstack/react-query";
import {
  threadChatQueryOptions,
  threadShellQueryOptions,
} from "@/queries/thread-queries";
import { ThreadPageShell } from "@terragon/shared";
import { getThreadPageShellAction } from "@/server-actions/get-thread-page-shell";
import { unwrapResult } from "@/lib/server-actions";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const userId = await getUserIdOrNull();
  if (!userId) {
    return { title: "Task | Terragon" };
  }
  const { id } = await params;
  const thread = unwrapResult(await getThreadPageShellAction(id));
  return {
    title: getThreadDocumentTitle(thread),
  };
}

export default async function TaskPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ readonly?: boolean }>;
}) {
  const userId = await getUserIdOrRedirect();
  const [{ id }, { readonly }] = await Promise.all([params, searchParams]);
  const queryClient = new QueryClient();
  const shellOptions = threadShellQueryOptions(id);
  await queryClient.prefetchQuery(shellOptions);
  const thread = queryClient.getQueryData<ThreadPageShell>(
    shellOptions.queryKey,
  );
  if (!thread) {
    return notFound();
  }
  await queryClient.prefetchQuery(
    threadChatQueryOptions({
      threadId: id,
      threadChatId: thread.primaryThreadChatId,
    }),
  );
  if (thread.draftMessage) {
    return redirect(`/dashboard`);
  }
  const isReadOnly = thread.userId !== userId || !!readonly;
  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <ChatUI threadId={id} isReadOnly={isReadOnly} />
    </HydrationBoundary>
  );
}
