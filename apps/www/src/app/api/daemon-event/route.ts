import { getUserIdOrNullFromDaemonToken } from "@/lib/auth-server";
import { handleDaemonEvent } from "@/server-lib/handle-daemon-event";
import { DaemonEventAPIBody } from "@terragon/daemon/shared";
import { LEGACY_THREAD_CHAT_ID } from "@terragon/shared/utils/thread-utils";

export async function POST(request: Request) {
  const json: DaemonEventAPIBody = await request.json();
  const {
    messages,
    threadId,
    threadChatId = LEGACY_THREAD_CHAT_ID,
    payloadVersion = 1,
    runId = null,
    eventId = null,
    seq = null,
    endSha = null,
    // Old clients don't send the timezone, so we fallback to UTC
    timezone = "UTC",
  } = json;
  const userId = await getUserIdOrNullFromDaemonToken(request);
  if (!userId) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Prefer computing context usage from the last non-result message's usage
  // fields when available. Do not sum across all messages.
  const computedContextUsage = (() => {
    try {
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i] as any;
        if (!m || m.type === "result") continue;
        const usage = m.message?.usage;
        if (!usage) continue;
        if (m.parent_tool_use_id) continue;
        const input = Number(usage.input_tokens ?? 0);
        const output = Number(usage.output_tokens ?? 0);
        const cacheCreate = Number(usage.cache_creation_input_tokens ?? 0);
        const cacheRead = Number(usage.cache_read_input_tokens ?? 0);
        const total = input + output + cacheCreate + cacheRead;
        return Number.isFinite(total) && total > 0 ? total : null;
      }
      return null;
    } catch (_e) {
      return null;
    }
  })();
  const result = await handleDaemonEvent({
    messages,
    threadId,
    threadChatId,
    userId,
    timezone,
    contextUsage: computedContextUsage ?? null,
    payloadVersion,
    runId,
    eventId,
    seq,
    endSha,
    traceId: crypto.randomUUID(),
  });

  if (!result.success) {
    return new Response(result.error, { status: result.status || 500 });
  }

  if (result.ackStatus === 202) {
    return new Response("Accepted", { status: 202 });
  }

  return new Response("OK");
}
