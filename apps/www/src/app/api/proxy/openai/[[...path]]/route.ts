import { env } from "@terragon/env/apps-www";
import {
  getOpenAIDaemonTokenFromHeaders,
  createProxyHandler,
} from "@/server-lib/proxy-handler";
import { logOpenAIUsage } from "../log-openai-usage";

export const dynamic = "force-dynamic";

function isResponsesPath(pathname: string) {
  return pathname === "/v1/responses" || pathname.startsWith("/v1/responses/");
}

function isChatCompletionsPath(pathname: string) {
  return (
    pathname === "/v1/chat/completions" ||
    pathname.startsWith("/v1/chat/completions/")
  );
}

function shouldLogUsage(pathname: string) {
  return isResponsesPath(pathname) || isChatCompletionsPath(pathname);
}

async function logOpenAIEventStreamUsage({
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
          // Handle Responses API format
          if (parsed?.type === "response.completed") {
            const usage = parsed.response?.usage;
            await logOpenAIUsage({
              path: targetUrl.pathname,
              responseId: parsed.response?.id ?? undefined,
              usage,
              userId,
              model: parsed.response?.model ?? undefined,
            });
            return true;
          }
          // Handle Chat Completions API format
          if (parsed?.usage) {
            await logOpenAIUsage({
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
    console.error("Failed to log OpenAI usage (event-stream)", error);
  } finally {
    if (!doneReading) {
      await reader.cancel().catch(() => undefined);
    } else {
      reader.releaseLock();
    }
  }
}

const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = createProxyHandler({
  baseUrl: "https://api.openai.com/",
  defaultPath: "v1/chat/completions",
  providerName: "openai",
  pathPrefix: "/v1/",
  getDaemonTokenFromHeaders: getOpenAIDaemonTokenFromHeaders,
  getApiKey: () => env.OPENAI_API_KEY,
  stripRequestHeaders: ["authorization", "x-daemon-token"],
  prepareRequestHeaders: (headers, apiKey) => {
    headers.set("Authorization", `Bearer ${apiKey}`);
  },
  shouldLogUsage,
  logEventStreamUsage: logOpenAIEventStreamUsage,
  logJsonUsage: async ({ buffer, targetUrl, userId }) => {
    const decoded = new TextDecoder().decode(buffer);
    const json = JSON.parse(decoded);
    const usage = json?.usage;
    if (usage) {
      await logOpenAIUsage({
        path: targetUrl.pathname,
        usage,
        userId,
        model: json?.model ?? undefined,
      });
    }
  },
});

export { GET, POST, PUT, PATCH, DELETE, OPTIONS };
