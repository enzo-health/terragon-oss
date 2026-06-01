import { EventType } from "@ag-ui/core";
import type { NextRequest } from "next/server";
import { isDevLoginEnabled } from "@/lib/auth";
import { encodeSseComment, encodeSseEvent } from "./ag-ui-sse-writer";

const SYNTHETIC_BENCHMARK_QUERY_VALUE = "long-stream";
const SYNTHETIC_BENCHMARK_CHUNK_DELAY_MS = 35;

export function isSyntheticBenchmarkRequest(request: NextRequest): boolean {
  return (
    isDevLoginEnabled() &&
    request.nextUrl.searchParams.get("syntheticBenchmark") ===
      SYNTHETIC_BENCHMARK_QUERY_VALUE
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function syntheticBenchmarkChunks(): string[] {
  return [
    "1. Smooth streaming keeps the user oriented while the agent is still thinking.\n\n",
    "2. Each visible update should feel incremental, not like the page is repainting from scratch.\n\n",
    "3. The transcript can be large, so historical rows need to stay quiet while the active row changes.\n\n",
    "4. Markdown should stabilize old blocks and only keep the live tail in motion.\n\n",
    "5. Scroll pinning should follow the answer without layout jumps or delayed catch-up.\n\n",
    "| Metric | Target | Why |\n| --- | ---: | --- |\n| Visible update gap | < 750ms | Users see steady progress |\n| RAF p95 | < 75ms | The main thread stays responsive |\n\n",
    "6. File citations like 【F:apps/www/src/components/chat/text-part.tsx†L1-L6】 should not force the renderer onto a permanent slow path.\n\n",
    "7. Tool argument deltas should coalesce before React sees them.\n\n",
    "8. The active message can contain ordinary prose, tables, and code without freezing the transcript.\n\n",
    '```ts\nexport function describeStreamingBudget(): string {\n  return "keep visible updates cheap";\n}\n```\n\n',
    "9. The final paragraph includes terragon-e2e-benchmark-visible so the benchmark knows the run completed.\n",
  ];
}

export function buildSyntheticBenchmarkStream({
  threadId,
}: {
  threadId: string;
}): ReadableStream<Uint8Array> {
  const runId = "synthetic-browser-stream-run";
  const messageId = "synthetic-browser-stream-message";
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const emit = async (
        event: Parameters<typeof encodeSseEvent>[0],
        waitMs = SYNTHETIC_BENCHMARK_CHUNK_DELAY_MS,
      ) => {
        controller.enqueue(
          encodeSseEvent({
            ...event,
            timestamp: Date.now(),
          }),
        );
        await delay(waitMs);
      };

      controller.enqueue(encodeSseComment("synthetic-ag-ui-stream"));
      await emit({ type: EventType.RUN_STARTED, threadId, runId }, 20);
      await emit(
        {
          type: EventType.TEXT_MESSAGE_START,
          messageId,
          role: "assistant",
        },
        20,
      );
      for (const delta of syntheticBenchmarkChunks()) {
        await emit({
          type: EventType.TEXT_MESSAGE_CONTENT,
          messageId,
          delta,
        });
      }
      await emit({ type: EventType.TEXT_MESSAGE_END, messageId }, 20);
      await emit({ type: EventType.RUN_FINISHED, threadId, runId }, 0);
      controller.close();
    },
  });
}
