import { NextRequest } from "next/server";
import { env } from "@terragon/env/apps-www";
import { db } from "@/lib/db";
import { getUserCreditBalance } from "@terragon/shared/model/credits";
import { maybeTriggerCreditAutoReload } from "@/server-lib/credit-auto-reload";
import { logOpenAIUsage } from "../log-openai-usage";
import { waitUntil } from "@vercel/functions";
import { validateProxyRequestModel } from "@/server-lib/proxy-model-validation";
import {
  getDaemonTokenAuthContextOrNull,
  hasDaemonProviderScope,
} from "@/lib/auth-server";
import { getAgentRunContextByRunId } from "@terragon/shared/model/agent-run-context";

const OPENAI_API_BASE = "https://api.openai.com/";
const DEFAULT_OPENAI_PATH = "v1/chat/completions";
const OPENAI_API_ORIGIN = new URL(OPENAI_API_BASE).origin;

export const dynamic = "force-dynamic";

type HandlerArgs = { params: Promise<{ path?: string[] }> };
type AuthContext = { userId: string };

function getDaemonTokenFromHeaders(headers: Headers) {
  const directToken = headers.get("X-Daemon-Token");
  if (directToken && directToken.trim() !== "") {
    return directToken.trim();
  }

  const authHeader = headers.get("authorization");
  if (!authHeader) {
    return null;
  }

  const match = authHeader.match(/^x-daemon-token\s+(.*)$/i);
  if (match && match[1]) {
    const token = match[1]!.trim();
    return token === "" ? null : token;
  }

  const bearerMatch = authHeader.match(/^\s*Bearer\s+(.*)$/i);
  if (bearerMatch && bearerMatch[1]) {
    const token = bearerMatch[1]!.trim();
    return token === "" ? null : token;
  }

  return null;
}

function buildTargetUrl(
  request: NextRequest,
  pathSegments: string[] | undefined,
) {
  const pathname =
    pathSegments && pathSegments.length > 0
      ? pathSegments.join("/")
      : DEFAULT_OPENAI_PATH;

  if (/^\s*https?:\/\//i.test(pathname) || pathname.startsWith("//")) {
    throw new Error("invalid proxy path");
  }

  const targetUrl = new URL(pathname, OPENAI_API_BASE);
  if (targetUrl.origin !== OPENAI_API_ORIGIN) {
    throw new Error("invalid proxy origin");
  }
  if (!targetUrl.pathname.startsWith("/v1/")) {
    throw new Error("invalid proxy path");
  }
  const search = request.nextUrl.search;
  if (search) {
    targetUrl.search = search;
  }

  return targetUrl;
}

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

function isJsonContentType(contentType: string | null) {
  return Boolean(contentType && contentType.includes("application/json"));
}

function isEventStreamContentType(contentType: string | null) {
  return Boolean(contentType && contentType.includes("text/event-stream"));
}

function findEventSeparator(buffer: string) {
  const lfIndex = buffer.indexOf("\n\n");
  const crlfIndex = buffer.indexOf("\r\n\r\n");
  if (lfIndex === -1 && crlfIndex === -1) {
    return null;
  }
  if (lfIndex !== -1 && (crlfIndex === -1 || lfIndex < crlfIndex)) {
    return { index: lfIndex, length: 2 } as const;
  }
  return { index: crlfIndex, length: 4 } as const;
}

async function logUsageFromEventStream({
  stream,
  targetUrl,
  userId,
}: {
  stream: ReadableStream<Uint8Array>;
  targetUrl: URL;
  userId: string;
}) {
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

async function proxyRequest(
  request: NextRequest,
  args: HandlerArgs,
  authContext: AuthContext,
) {
  const params = await args.params;
  let targetUrl: URL;
  try {
    targetUrl = buildTargetUrl(request, params.path);
  } catch {
    return new Response("Invalid proxy path", { status: 400 });
  }

  // Validate that only GPT-5.1 models are being requested
  const validation = await validateProxyRequestModel({
    request,
    provider: "openai",
  });
  if (!validation.valid) {
    return new Response(validation.error, { status: 400 });
  }

  const headers = new Headers();
  for (const [key, value] of request.headers.entries()) {
    const lowerKey = key.toLowerCase();
    if (
      lowerKey === "host" ||
      lowerKey === "content-length" ||
      lowerKey === "connection" ||
      lowerKey === "authorization"
    ) {
      continue;
    }
    headers.set(key, value);
  }
  headers.set("Authorization", `Bearer ${env.OPENAI_API_KEY}`);

  const body =
    request.method === "GET" || request.method === "HEAD"
      ? undefined
      : await request.arrayBuffer();

  const response = await fetch(targetUrl, {
    method: request.method,
    headers,
    body,
    redirect: "manual",
  });

  let responseBody: BodyInit | null = response.body;
  if (shouldLogUsage(targetUrl.pathname)) {
    const contentType = response.headers.get("content-type");
    if (isEventStreamContentType(contentType) && response.body) {
      const [clientStream, loggingStream] = response.body.tee();
      responseBody = clientStream;
      void logUsageFromEventStream({
        stream: loggingStream,
        targetUrl,
        userId: authContext.userId,
      }).catch((error) => {
        console.error(
          "Failed to log OpenAI usage (event-stream handler)",
          error,
        );
      });
    } else if (isJsonContentType(contentType)) {
      try {
        const buffer = await response.arrayBuffer();
        responseBody = buffer;
        const decoded = new TextDecoder().decode(buffer);
        const json = JSON.parse(decoded);
        const usage = json?.usage;
        if (usage) {
          await logOpenAIUsage({
            path: targetUrl.pathname,
            usage,
            userId: authContext.userId,
            model: json?.model ?? undefined,
          });
        }
      } catch (error) {
        console.error("Failed to log OpenAI usage (json)", error);
      }
    }
  }

  const responseHeaders = new Headers();
  for (const [key, value] of response.headers.entries()) {
    const lowerKey = key.toLowerCase();
    if (
      lowerKey === "content-length" ||
      lowerKey === "connection" ||
      lowerKey === "transfer-encoding" ||
      lowerKey === "content-encoding"
    ) {
      continue;
    }
    responseHeaders.set(key, value);
  }

  const origin = request.headers.get("origin");
  if (origin) {
    responseHeaders.set("Access-Control-Allow-Origin", origin);
    responseHeaders.set("Access-Control-Allow-Credentials", "true");
    responseHeaders.append("Vary", "Origin");
  } else {
    responseHeaders.set("Access-Control-Allow-Origin", "*");
  }

  return new Response(responseBody, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

async function authorize(
  request: NextRequest,
): Promise<
  | { response: Response; userId?: undefined }
  | { response: null; userId: string }
> {
  const token = getDaemonTokenFromHeaders(request.headers);
  if (!token) {
    return { response: new Response("Unauthorized", { status: 401 }) };
  }

  try {
    const daemonAuth = await getDaemonTokenAuthContextOrNull({
      headers: new Headers({ "X-Daemon-Token": token }),
    });
    if (!daemonAuth || !daemonAuth.claims) {
      console.log("Unauthorized OpenAI proxy request");
      return { response: new Response("Unauthorized", { status: 401 }) };
    }
    const userId = daemonAuth.userId;
    const claims = daemonAuth.claims;
    if (!hasDaemonProviderScope(claims, "openai") || claims.exp <= Date.now()) {
      console.log("OpenAI proxy access denied: provider scope mismatch", {
        userId,
        runId: claims.runId,
      });
      return { response: new Response("Unauthorized", { status: 401 }) };
    }
    const runContext = await getAgentRunContextByRunId({
      db,
      runId: claims.runId,
      userId,
    });
    if (!runContext) {
      return { response: new Response("Unauthorized", { status: 401 }) };
    }
    if (
      !daemonAuth.keyId ||
      !runContext.daemonTokenKeyId ||
      daemonAuth.keyId !== runContext.daemonTokenKeyId ||
      runContext.runId !== claims.runId ||
      runContext.threadId !== claims.threadId ||
      runContext.threadChatId !== claims.threadChatId ||
      runContext.sandboxId !== claims.sandboxId ||
      runContext.agent !== claims.agent ||
      runContext.transportMode !== claims.transportMode ||
      runContext.protocolVersion !== claims.protocolVersion ||
      runContext.tokenNonce !== claims.nonce ||
      runContext.status === "completed" ||
      runContext.status === "failed" ||
      runContext.status === "stopped"
    ) {
      console.log("OpenAI proxy access denied: run context mismatch", {
        userId,
        runId: claims.runId,
      });
      return { response: new Response("Unauthorized", { status: 401 }) };
    }

    const { balanceCents } = await getUserCreditBalance({
      db,
      userId,
      skipAggCache: false,
    });
    waitUntil(maybeTriggerCreditAutoReload({ userId, balanceCents }));
    if (balanceCents <= 0) {
      console.log("OpenAI proxy access denied: insufficient credits", {
        userId,
        balanceCents,
      });
      return {
        response: new Response("Insufficient credits", { status: 402 }),
      };
    }
    return { response: null, userId };
  } catch (err) {
    console.error("Failed to verify OpenAI proxy request", err);
    return { response: new Response("Unauthorized", { status: 401 }) };
  }
}

async function handleWithAuth(
  request: NextRequest,
  args: HandlerArgs,
  handler: (
    request: NextRequest,
    args: HandlerArgs,
    context: AuthContext,
  ) => Promise<Response>,
) {
  const authResult = await authorize(request);
  if (authResult.response) {
    return authResult.response;
  }
  return handler(request, args, { userId: authResult.userId });
}

export async function GET(request: NextRequest, args: HandlerArgs) {
  return handleWithAuth(request, args, proxyRequest);
}

export async function POST(request: NextRequest, args: HandlerArgs) {
  return handleWithAuth(request, args, proxyRequest);
}

export async function PUT(request: NextRequest, args: HandlerArgs) {
  return handleWithAuth(request, args, proxyRequest);
}

export async function PATCH(request: NextRequest, args: HandlerArgs) {
  return handleWithAuth(request, args, proxyRequest);
}

export async function DELETE(request: NextRequest, args: HandlerArgs) {
  return handleWithAuth(request, args, proxyRequest);
}

export async function OPTIONS(request: NextRequest) {
  const origin = request.headers.get("origin");
  const allowOrigin = origin ?? "*";
  const allowHeaders =
    request.headers.get("access-control-request-headers") ??
    "authorization, content-type";

  const headers: Record<string, string> = {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": allowHeaders,
    Vary: "Origin",
  };

  if (allowOrigin !== "*") {
    headers["Access-Control-Allow-Credentials"] = "true";
  }

  return new Response(null, {
    status: 204,
    headers,
  });
}
