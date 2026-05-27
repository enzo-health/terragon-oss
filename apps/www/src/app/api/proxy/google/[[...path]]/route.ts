import { NextRequest } from "next/server";
import { env } from "@terragon/env/apps-www";
import {
  getGoogleDaemonTokenFromHeaders,
  createProxyHandler,
} from "@/server-lib/proxy-handler";
import { logGoogleUsage } from "../log-google-usage";

export const dynamic = "force-dynamic";

const GOOGLE_API_BASE = "https://generativelanguage.googleapis.com/";

function isGenerateContentPath(pathname: string) {
  return (
    pathname.includes("generateContent") ||
    pathname.includes("streamGenerateContent")
  );
}

function shouldLogUsage(pathname: string) {
  return isGenerateContentPath(pathname);
}

function buildTargetUrl(
  request: NextRequest,
  pathSegments: string[] | undefined,
) {
  let pathname =
    pathSegments && pathSegments.length > 0
      ? pathSegments.join("/")
      : "v1beta/models/gemini-2.5-pro:streamGenerateContent";
  pathname = pathname.replace("v1/models", "v1beta/models");

  if (/^\s*https?:\/\//i.test(pathname) || pathname.startsWith("//")) {
    throw new Error("invalid proxy path");
  }

  const targetUrl = new URL(pathname, GOOGLE_API_BASE);
  if (targetUrl.origin !== new URL(GOOGLE_API_BASE).origin) {
    throw new Error("invalid proxy origin");
  }
  if (!targetUrl.pathname.startsWith("/v1beta/")) {
    throw new Error("invalid proxy path");
  }

  const apiKey = env.GOOGLE_AI_STUDIO_API_KEY;
  if (apiKey) {
    targetUrl.searchParams.set("key", apiKey);
  }

  for (const [key, value] of request.nextUrl.searchParams.entries()) {
    if (key !== "key") {
      targetUrl.searchParams.set(key, value);
    }
  }

  return targetUrl;
}

async function logGoogleEventStreamUsage({
  stream,
  targetUrl,
  userId,
  model,
}: {
  stream: ReadableStream<Uint8Array>;
  targetUrl: URL;
  userId: string;
  model?: string;
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
          if (parsed?.usageMetadata) {
            await logGoogleUsage({
              path: targetUrl.pathname,
              usage: parsed.usageMetadata,
              userId,
              model: model ?? parsed.modelVersion ?? undefined,
            });
            return true;
          }
        } catch (_error) {
          if (process.env.NODE_ENV !== "production") {
            console.error("Failed to parse event stream payload:", payload);
          }
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
    console.error("Failed to log Google usage (event-stream)", error);
  } finally {
    if (!doneReading) {
      await reader.cancel().catch(() => undefined);
    } else {
      reader.releaseLock();
    }
  }
}

function extractModelFromBody(bodyBuffer: ArrayBuffer): string | undefined {
  try {
    const decoded = new TextDecoder().decode(bodyBuffer);
    const json = JSON.parse(decoded);
    return json?.model;
  } catch {
    return undefined;
  }
}

const { GET, POST, PUT, PATCH, DELETE, OPTIONS } = createProxyHandler({
  baseUrl: GOOGLE_API_BASE,
  defaultPath: "v1beta/models/gemini-2.5-pro:streamGenerateContent",
  providerName: "google",
  pathPrefix: "/v1beta/",
  getDaemonTokenFromHeaders: getGoogleDaemonTokenFromHeaders,
  getApiKey: () => env.GOOGLE_AI_STUDIO_API_KEY,
  buildTargetUrl,
  stripRequestHeaders: ["authorization", "x-daemon-token", "x-goog-api-key"],
  readBodyDuringAuth: true,
  extractModelFromBody,
  prepareRequestHeaders: () => {
    // Google uses API key in query params, not headers
  },
  shouldLogUsage,
  logEventStreamUsage: logGoogleEventStreamUsage,
  logJsonUsage: async ({ buffer, targetUrl, userId, model }) => {
    const decoded = new TextDecoder().decode(buffer);
    const json = JSON.parse(decoded);
    const usage = json?.usageMetadata;
    if (usage) {
      await logGoogleUsage({
        path: targetUrl.pathname,
        usage,
        userId,
        model: model ?? json?.modelVersion ?? undefined,
      });
    }
  },
});

export { GET, POST, PUT, PATCH, DELETE, OPTIONS };
