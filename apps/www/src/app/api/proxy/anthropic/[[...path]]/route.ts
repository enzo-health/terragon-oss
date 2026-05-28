import { env } from "@terragon/env/apps-www";
import {
  getBearerDaemonTokenFromHeaders,
  createProxyHandler,
} from "@/server-lib/proxy-handler";
import { logAnthropicUsage } from "../log-anthropic-usage";

export const dynamic = "force-dynamic";

type AnthropicUsagePayload = {
  usage?: {
    input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
    output_tokens?: number | null;
  } | null;
  model?: string | null;
  id?: string | null;
  message?: {
    id?: string | null;
    model?: string | null;
    usage?: AnthropicUsagePayload["usage"];
  } | null;
};

function isMessagesPath(pathname: string) {
  return pathname === "/v1/messages" || pathname.startsWith("/v1/messages/");
}

export async function logAnthropicEventStreamUsage({
  stream,
  targetUrl,
  userId,
}: {
  stream: ReadableStream<Uint8Array>;
  targetUrl: URL;
  userId: string;
}) {
  const { findEventSeparator, parseStreamEvent } = await import(
    "@/server-lib/proxy-handler"
  );

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let doneReading = false;
  let knownModel: string | null | undefined;
  let knownMessageId: string | null | undefined;
  const aggregatedUsageTotals: Record<
    | "input_tokens"
    | "cache_creation_input_tokens"
    | "cache_read_input_tokens"
    | "output_tokens",
    number
  > = {
    input_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 0,
  };
  let sawUsageEvent = false;

  const STREAM_USAGE_KEYS = [
    "input_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
    "output_tokens",
  ] as const;

  const processBuffer = async () => {
    let separator = findEventSeparator(buffer);
    while (separator) {
      const rawEvent = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator.length);
      if (!rawEvent.trim()) {
        separator = findEventSeparator(buffer);
        continue;
      }

      const parsed = parseStreamEvent(rawEvent);
      if (!parsed) {
        separator = findEventSeparator(buffer);
        continue;
      }

      const payload = parsed.payload as AnthropicUsagePayload;
      const usage = payload?.usage ?? payload?.message?.usage;
      const model = payload?.message?.model ?? payload?.model;
      const messageId = payload?.message?.id ?? payload?.id;

      if (!knownModel && model) {
        knownModel = model;
      }
      if (!knownMessageId && messageId) {
        knownMessageId = messageId;
      }

      if (usage) {
        sawUsageEvent = true;
        for (const key of STREAM_USAGE_KEYS) {
          const rawValue = (usage as Record<string, unknown>)[key];
          if (rawValue == null) continue;
          const parsedValue = Number(rawValue);
          if (!Number.isFinite(parsedValue)) continue;
          const value = Math.max(parsedValue, 0);
          if (value > aggregatedUsageTotals[key]) {
            aggregatedUsageTotals[key] = value;
          }
        }
      }

      separator = findEventSeparator(buffer);
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: true });
        await processBuffer();
      }
      if (done) {
        buffer += decoder.decode();
        await processBuffer();
        doneReading = true;
        break;
      }
    }
  } catch (error) {
    console.error(
      "Failed to log Anthropic messages usage (event-stream)",
      error,
    );
  } finally {
    if (!doneReading) {
      await reader.cancel().catch(() => undefined);
    } else {
      reader.releaseLock();
    }
  }

  if (sawUsageEvent) {
    const aggregatedUsageForLogging: Record<string, number> = {};
    let hasUsage = false;
    for (const key of STREAM_USAGE_KEYS) {
      const total = aggregatedUsageTotals[key];
      if (total > 0) {
        aggregatedUsageForLogging[key] = total;
        hasUsage = true;
      }
    }
    if (hasUsage) {
      try {
        await logAnthropicUsage({
          path: targetUrl.pathname,
          usage: aggregatedUsageForLogging,
          userId,
          model: knownModel ?? null,
          messageId: knownMessageId ?? null,
        });
      } catch (error) {
        console.error(
          "Failed to log Anthropic messages usage (aggregated event-stream)",
          error,
        );
      }
    }
  }
}

const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = createProxyHandler({
  baseUrl: "https://api.anthropic.com/",
  defaultPath: "v1/messages",
  providerName: "anthropic",
  pathPrefix: "/v1/",
  getDaemonTokenFromHeaders: getBearerDaemonTokenFromHeaders,
  getApiKey: () => env.ANTHROPIC_API_KEY,
  stripRequestHeaders: ["x-api-key", "authorization", "x-daemon-token"],
  prepareRequestHeaders: (headers, apiKey) => {
    headers.set("x-api-key", apiKey);
    if (!headers.has("anthropic-version")) {
      headers.set("anthropic-version", "2023-06-01");
    }
  },
  shouldLogUsage: isMessagesPath,
  logEventStreamUsage: logAnthropicEventStreamUsage,
  logJsonUsage: async ({ buffer, targetUrl, userId }) => {
    const decoded = new TextDecoder().decode(buffer);
    const json = JSON.parse(decoded) as AnthropicUsagePayload;
    if (json?.usage) {
      await logAnthropicUsage({
        path: targetUrl.pathname,
        usage: json.usage,
        userId,
        model: json.model ?? json.message?.model ?? null,
        messageId: json.id ?? json.message?.id ?? null,
      });
    }
  },
});

export { GET, POST, PUT, PATCH, DELETE, OPTIONS };
