import { getSdlcLoopStatusAction } from "@/server-actions/get-sdlc-loop-status";
import { useQuery } from "@tanstack/react-query";
import { getServerActionQueryOptions } from "./server-action-helpers";

export const sdlcLoopStatusQueryKeys = {
  detail: (threadId: string) =>
    ["sdlc-loop-status", "detail", threadId] as const,
};

export function sdlcLoopStatusQueryOptions(threadId: string) {
  return getServerActionQueryOptions({
    queryKey: sdlcLoopStatusQueryKeys.detail(threadId),
    queryFn: async () => {
      return await getSdlcLoopStatusAction(threadId);
    },
    staleTime: 15_000,
    refetchInterval: (query) => (query.state.data ? 30_000 : 120_000),
  });
}

export function useSdlcLoopStatusQuery({
  threadId,
  enabled = true,
}: {
  threadId: string;
  enabled?: boolean;
}) {
  return useQuery({
    ...sdlcLoopStatusQueryOptions(threadId),
    enabled,
  });
}
