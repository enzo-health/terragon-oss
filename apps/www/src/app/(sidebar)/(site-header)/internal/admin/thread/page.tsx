import { getAdminUserOrThrow } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { AdminThreadsList } from "@/components/admin/threads-list";
import {
  getThreadCountsForAdmin,
  getThreadsForAdmin,
} from "@leo/shared/model/threads";
import { allThreadErrors } from "@/agent/error";
import { allThreadStatuses } from "@/agent/thread-status";
import { ThreadSource, ThreadStatus } from "@leo/shared/db/types";
import { AIAgent } from "@leo/agent/types";

export default async function AdminThreadsPage({
  searchParams,
}: {
  searchParams: Promise<{
    active?: string;
    queued?: string;
    status?: string;
    source?: string;
    error?: string;
    agent?: string;
  }>;
}) {
  await getAdminUserOrThrow();

  // Filter by query params
  let statusArr: ThreadStatus[] | undefined;
  const { status, queued, active, error, source, agent } = await searchParams;
  if (!!queued) {
    statusArr = [
      "queued-sandbox-creation-rate-limit",
      "queued-agent-rate-limit",
      "queued-tasks-concurrency",
    ];
  } else if (!!active) {
    statusArr = [
      "booting",
      "working",
      "stopping",
      "working-done",
      "working-error",
      "checkpointing",
    ];
  } else if (typeof status === "string") {
    statusArr = [];
    for (const part of status.split(",")) {
      if (part in allThreadStatuses) {
        statusArr.push(part as ThreadStatus);
      }
    }
  }
  let errorMessage: boolean | undefined;
  if (!!error) {
    errorMessage = true;
  }
  let sourceType: ThreadSource | undefined;
  if (typeof source === "string") {
    sourceType = source as ThreadSource;
  }
  let agentType: AIAgent | undefined;
  if (typeof agent === "string") {
    agentType = agent as AIAgent;
  }
  const limit = 50;
  const pastWeek = new Date();
  pastWeek.setDate(pastWeek.getDate() - 7);
  const [threads, counts] = await Promise.all([
    getThreadsForAdmin({
      db,
      limit,
      status: statusArr,
      errorMessage,
      sourceType,
      agent: agentType,
    }),
    getThreadCountsForAdmin({ db, updatedSince: pastWeek }),
  ]);

  let totalThreads = 0;
  const byStatus: Record<string, number> = {};
  for (const count of counts.byStatus) {
    totalThreads += count.count;
    byStatus[count.status] = count.count;
  }
  const byAgent: Record<string, number> = {};
  if (Array.isArray(counts.byAgent)) {
    for (const count of counts.byAgent) {
      if (count.agent) {
        byAgent[count.agent] = count.count;
      }
    }
  }
  const bySource: Record<string, number> = {};
  if (Array.isArray(counts.bySource)) {
    for (const count of counts.bySource) {
      if (count.source) {
        bySource[count.source] = count.count;
      }
    }
  }
  const byErrorMessage: Record<string, number> = {};
  for (const count of counts.byErrorMessage) {
    if (count.errorMessage) {
      byErrorMessage["total"] = (byErrorMessage["total"] ?? 0) + count.count;
      if (count.errorMessage in allThreadErrors) {
        byErrorMessage[count.errorMessage] = count.count;
      } else {
        byErrorMessage["other"] = (byErrorMessage["other"] ?? 0) + count.count;
      }
    }
  }
  return (
    <AdminThreadsList
      threads={threads}
      counts={{
        total: totalThreads,
        byStatus,
        byErrorMessage,
        byAgent,
        bySource,
      }}
      where={{
        status: statusArr,
        limit,
        errorMessage,
        sourceType,
        agent: agentType,
      }}
    />
  );
}
