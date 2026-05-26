import { NextRequest } from "next/server";
import { env } from "@terragon/env/apps-www";
import {
  getOpenAIDaemonTokenFromHeaders,
  createProxyHandler,
} from "@/server-lib/proxy-handler";
import { logOpenRouterUsage } from "../log-usage";

export const dynamic = "force-dynamic";

const OPENROUTER_API_BASE = "https://openrouter.ai/api/";

function isChatCompletionsPath(pathname: string) {
  return pathname.startsWith("/api/v1/chat/completions");
}

function isCompletionsPath(pathname: string) {
  return pathname.startsWith("/api/v1/completions");
}

function shouldLogUsage(pathname: string) {
  return isChatCompletionsPath(pathname) || isCompletionsPath(pathname);
}

function buildTargetUrl(
  request: NextRequest,
  pathSegments: string[] | undefined,
) {
  const pathname =
    pathSegments && pathSegments.length > 0
      ? pathSegments.join("/")
      : "v1/chat/completions";

  if (/^\s*https?:\/\//i.test(pathname) || pathname.startsWith("//")) {
    throw new Error("invalid proxy path");
  }

  const targetUrl = new URL(pathname, OPENROUTER_API_BASE);
  if (targetUrl.origin !== new URL(OPENROUTER_API_BASE).origin) {
    throw new Error("invalid proxy origin");
  }
  if (!targetUrl.pathname.startsWith("/api/v1/")) {
    throw new Error("invalid proxy path");
  }

  if (request.nextUrl.searchParams.toString()) {
    targetUrl.search = request.nextUrl.searchParams.toString();
  }

  return targetUrl;
}

async function logOpenRouterEventStreamUsage({
  stream,
  targetUrl,
  userId,
}: {
  stream: ReadableStream<Uint8Array>;
  targetUrl: URL;
  userId: string;
}) {
  const { findEventSeparator } = await import("@/server-lib/proxy-handler");

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let logged = false;
  let doneReading = false;

  const processBuffer = async () => {
    let separator = findEventSeparator(buffer);
    while (separator) {
      const rawEvent = buffer.slice(0, separator.index);
      buffer = buffer.slice(separator.index + separator.length);
      const lines = rawEvent.split(/\r?\n/);
      const dataLines = lines
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart());
      if (dataLines.length > 0) {
        const payload = dataLines.join("\n");
        if (payload === "[DONE]") {
          separator = findEventSeparator(buffer);
          continue;
        }
        try {
          const parsed = JSON.parse(payload);
          if (parsed?.usage) {
            await logOpenRouterUsage({
              path: targetUrl.pathname,
              usage: parsed.usage,
              userId,
              model: parsed.model ?? undefined,
            });
            return true;
          }
        } catch (_error) {
          // Ignore payloads that are not JSON objects
        }
      }
      separator = findEventSeparator(buffer);
    }
    return false;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (value) {
        buffer += decoder.decode(value, { stream: true });
        logged = (await processBuffer()) || logged;
        if (logged && !done) {
          break;
        }
      }
      if (done) {
        buffer += decoder.decode();
        logged = (await processBuffer()) || logged;
        doneReading = true;
        break;
      }
    }
  } catch (error) {
    console.error("Failed to log OpenRouter usage (event-stream)", error);
  } finally {
    if (!doneReading) {
      await reader.cancel().catch(() => undefined);
    } else {
      reader.releaseLock();
    }
  }
}

const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = createProxyHandler({
  baseUrl: OPENROUTER_API_BASE,
  defaultPath: "v1/chat/completions",
  providerName: "openrouter",
  pathPrefix: "/api/v1/",
  getDaemonTokenFromHeaders: getOpenAIDaemonTokenFromHeaders,
  getApiKey: () => env.OPENROUTER_API_KEY,
  buildTargetUrl,
  stripRequestHeaders: ["authorization", "x-daemon-token"],
  readBodyDuringAuth: true,
  prepareRequestHeaders: (headers, apiKey) => {
    headers.set("Authorization", `Bearer ${apiKey}`);
  },
  shouldLogUsage,
  logEventStreamUsage: logOpenRouterEventStreamUsage,
  logJsonUsage: async ({ buffer, targetUrl, userId }) => {
    const decoded = new TextDecoder().decode(buffer);
    const json = JSON.parse(decoded);
    const usage = json?.usage;
    if (usage) {
      await logOpenRouterUsage({
        path: targetUrl.pathname,
        usage,
        userId,
        model: json?.model ?? undefined,
      });
    }
  },
});

export { GET, POST, PUT, PATCH, DELETE, OPTIONS };
