import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { getUserCreditBalance } from "@terragon/shared/model/credits";
import { maybeTriggerCreditAutoReload } from "@/server-lib/credit-auto-reload";
import { waitUntil } from "@vercel/functions";
import { validateProxyRequestModel } from "@/server-lib/proxy-model-validation";
import {
  getDaemonTokenAuthContextOrNull,
  hasDaemonProviderScope,
} from "@/lib/auth-server";
import { getAgentRunContextByRunId } from "@terragon/shared/model/agent-run-context";

export type HandlerArgs = { params: Promise<{ path?: string[] }> };
export type AuthContext = {
  userId: string;
  bodyBuffer?: ArrayBuffer;
  model?: string;
};

export type StreamEvent = {
  eventType: string | null;
  payload: unknown;
};

export function findEventSeparator(buffer: string) {
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

export function parseStreamEvent(rawEvent: string): StreamEvent | null {
  const lines = rawEvent.split(/\r?\n/);
  const dataLines: string[] = [];
  let eventType: string | null = null;

  for (const line of lines) {
    if (line.startsWith("event:")) {
      eventType = line.slice(6).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return null;
  }

  const payloadText = dataLines.join("\n");

  try {
    const payload = JSON.parse(payloadText);
    return { eventType, payload };
  } catch (_error) {
    return null;
  }
}

export function isJsonContentType(contentType: string | null) {
  return Boolean(contentType && contentType.includes("application/json"));
}

export function isEventStreamContentType(contentType: string | null) {
  return Boolean(contentType && contentType.includes("text/event-stream"));
}

export function getBearerDaemonTokenFromHeaders(
  headers: Headers,
): string | null {
  const directToken = headers.get("X-Daemon-Token");
  if (directToken && directToken.trim() !== "") {
    return directToken.trim();
  }

  const authHeader = headers.get("authorization");
  if (!authHeader) {
    return null;
  }

  const match = authHeader.match(/^\s*Bearer\s+(.*)$/i);
  if (match && match[1]) {
    const token = match[1]!.trim();
    return token === "" ? null : token;
  }

  return null;
}

export function getOpenAIDaemonTokenFromHeaders(
  headers: Headers,
): string | null {
  const directToken = headers.get("X-Daemon-Token");
  if (directToken && directToken.trim() !== "") {
    return directToken.trim();
  }

  const authHeader = headers.get("authorization");
  if (!authHeader) {
    return null;
  }

  const daemonTokenMatch = authHeader.match(/^x-daemon-token\s+(.*)$/i);
  if (daemonTokenMatch && daemonTokenMatch[1]) {
    const token = daemonTokenMatch[1]!.trim();
    return token === "" ? null : token;
  }

  const bearerMatch = authHeader.match(/^\s*Bearer\s+(.*)$/i);
  if (bearerMatch && bearerMatch[1]) {
    const token = bearerMatch[1]!.trim();
    return token === "" ? null : token;
  }

  return null;
}

export function getGoogleDaemonTokenFromHeaders(
  headers: Headers,
): string | null {
  const directToken = headers.get("X-Daemon-Token");
  if (directToken && directToken.trim() !== "") {
    return directToken.trim();
  }
  const googleApiKey = headers.get("x-goog-api-key");
  if (googleApiKey && googleApiKey.trim() !== "") {
    return googleApiKey.trim();
  }
  const authHeader = headers.get("authorization");
  if (!authHeader) {
    return null;
  }
  const match = authHeader.match(/^\s*Bearer\s+(.*)$/i);
  if (match && match[1]) {
    const token = match[1]!.trim();
    return token === "" ? null : token;
  }
  return null;
}

export type ProxyProviderConfig = {
  baseUrl: string;
  defaultPath: string;
  providerName: "openai" | "anthropic" | "google" | "openrouter";
  apiVersion?: string;
  pathPrefix: string;

  getDaemonTokenFromHeaders: (headers: Headers) => string | null;
  getApiKey: () => string | undefined;

  buildTargetUrl?: (
    request: NextRequest,
    pathSegments: string[] | undefined,
  ) => URL;

  stripRequestHeaders?: string[];
  prepareRequestHeaders?: (headers: Headers, apiKey: string) => void;

  readBodyDuringAuth?: boolean;
  extractModelFromBody?: (bodyBuffer: ArrayBuffer) => string | undefined;

  shouldLogUsage: (pathname: string) => boolean;
  logEventStreamUsage: (args: {
    stream: ReadableStream<Uint8Array>;
    targetUrl: URL;
    userId: string;
    model?: string;
  }) => Promise<void> | void;
  logJsonUsage: (args: {
    buffer: ArrayBuffer;
    targetUrl: URL;
    userId: string;
    model?: string;
  }) => Promise<void> | void;
};

export function createProxyHandler(config: ProxyProviderConfig) {
  const baseOrigin = new URL(config.baseUrl).origin;

  function buildTargetUrl(
    request: NextRequest,
    pathSegments: string[] | undefined,
  ): URL {
    if (config.buildTargetUrl) {
      return config.buildTargetUrl(request, pathSegments);
    }

    const pathname =
      pathSegments && pathSegments.length > 0
        ? pathSegments.join("/")
        : config.defaultPath;

    if (/^\s*https?:\/\//i.test(pathname) || pathname.startsWith("//")) {
      throw new Error("invalid proxy path");
    }

    const targetUrl = new URL(pathname, config.baseUrl);
    if (targetUrl.origin !== baseOrigin) {
      throw new Error("invalid proxy origin");
    }
    if (!targetUrl.pathname.startsWith(config.pathPrefix)) {
      throw new Error("invalid proxy path");
    }
    const search = request.nextUrl.search;
    if (search) {
      targetUrl.search = search;
    }

    return targetUrl;
  }

  function filterRequestHeaders(headers: Headers): Headers {
    const result = new Headers();
    const alwaysStrip = new Set(["host", "content-length", "connection"]);
    const toStrip = new Set([
      ...alwaysStrip,
      ...(config.stripRequestHeaders ?? []),
    ]);

    for (const [key, value] of headers.entries()) {
      if (toStrip.has(key.toLowerCase())) {
        continue;
      }
      result.set(key, value);
    }
    return result;
  }

  function filterResponseHeaders(response: Response): Headers {
    const result = new Headers();
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
      result.set(key, value);
    }
    return result;
  }

  function setCorsHeaders(
    request: NextRequest,
    responseHeaders: Headers,
  ): void {
    const origin = request.headers.get("origin");
    if (origin) {
      responseHeaders.set("Access-Control-Allow-Origin", origin);
      responseHeaders.set("Access-Control-Allow-Credentials", "true");
      responseHeaders.append("Vary", "Origin");
    } else {
      responseHeaders.set("Access-Control-Allow-Origin", "*");
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

    const validation = await validateProxyRequestModel({
      request,
      provider: config.providerName as
        | "anthropic"
        | "openai"
        | "openrouter"
        | "google",
      bodyBuffer: authContext.bodyBuffer,
    });
    if (!validation.valid) {
      return new Response(validation.error, { status: 400 });
    }

    const headers = filterRequestHeaders(request.headers);

    const apiKey = config.getApiKey();
    if (!apiKey) {
      throw new Error(`${config.providerName} API key not configured`);
    }

    if (config.prepareRequestHeaders) {
      config.prepareRequestHeaders(headers, apiKey);
    }

    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : (authContext.bodyBuffer ?? (await request.arrayBuffer()));

    const response = await fetch(targetUrl, {
      method: request.method,
      headers,
      body,
      redirect: "manual",
      signal: request.signal,
    });

    let responseBody: BodyInit | null = response.body;
    if (config.shouldLogUsage(targetUrl.pathname)) {
      const contentType = response.headers.get("content-type");
      if (isEventStreamContentType(contentType) && response.body) {
        const [clientStream, loggingStream] = response.body.tee();
        responseBody = clientStream;
        void Promise.resolve(
          config.logEventStreamUsage({
            stream: loggingStream,
            targetUrl,
            userId: authContext.userId,
            model: authContext.model,
          }),
        ).catch((error: unknown) => {
          console.error(
            `Failed to log ${config.providerName} usage (event-stream handler)`,
            error,
          );
        });
      } else if (isJsonContentType(contentType)) {
        try {
          const buffer = await response.arrayBuffer();
          responseBody = buffer;
          await config.logJsonUsage({
            buffer,
            targetUrl,
            userId: authContext.userId,
            model: authContext.model,
          });
        } catch (error) {
          console.error(
            `Failed to log ${config.providerName} usage (json)`,
            error,
          );
        }
      }
    }

    const responseHeaders = filterResponseHeaders(response);
    setCorsHeaders(request, responseHeaders);

    return new Response(responseBody, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  }

  async function authorize(request: NextRequest): Promise<
    | {
        response: Response;
        userId?: undefined;
        bodyBuffer?: undefined;
        model?: undefined;
      }
    | {
        response: null;
        userId: string;
        bodyBuffer?: ArrayBuffer;
        model?: string;
      }
  > {
    const token = config.getDaemonTokenFromHeaders(request.headers);
    if (!token) {
      return { response: new Response("Unauthorized", { status: 401 }) };
    }

    let bodyBuffer: ArrayBuffer | undefined;
    let model: string | undefined;

    if (
      config.readBodyDuringAuth &&
      request.method !== "GET" &&
      request.method !== "HEAD"
    ) {
      bodyBuffer = await request.arrayBuffer();
      if (config.extractModelFromBody && bodyBuffer) {
        model = config.extractModelFromBody(bodyBuffer);
      }
    }

    const apiKey = config.getApiKey();
    if (!apiKey) {
      if (process.env.NODE_ENV !== "production") {
        console.log(
          `${config.providerName} proxy access denied: API key not configured`,
        );
      }
      return {
        response: new Response(
          `${config.providerName} provider not configured on this server`,
          { status: 503 },
        ),
      };
    }

    try {
      const daemonAuth = await getDaemonTokenAuthContextOrNull({
        headers: new Headers({ "X-Daemon-Token": token }),
      });
      if (!daemonAuth || !daemonAuth.claims) {
        if (process.env.NODE_ENV !== "production") {
          console.log(`Unauthorized ${config.providerName} proxy request`);
        }
        return { response: new Response("Unauthorized", { status: 401 }) };
      }
      const userId = daemonAuth.userId;
      const claims = daemonAuth.claims;
      if (
        !hasDaemonProviderScope(claims, config.providerName) ||
        claims.exp <= Date.now()
      ) {
        if (process.env.NODE_ENV !== "production") {
          console.log(
            `${config.providerName} proxy access denied: provider scope mismatch`,
            {
              userId,
              runId: claims.runId,
            },
          );
        }
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
        if (process.env.NODE_ENV !== "production") {
          console.log(
            `${config.providerName} proxy access denied: run context mismatch`,
            {
              userId,
              runId: claims.runId,
            },
          );
        }
        return { response: new Response("Unauthorized", { status: 401 }) };
      }

      const { balanceCents } = await getUserCreditBalance({
        db,
        userId,
        skipAggCache: false,
      });
      waitUntil(maybeTriggerCreditAutoReload({ userId, balanceCents }));
      if (balanceCents <= 0) {
        if (process.env.NODE_ENV !== "production") {
          console.log(
            `${config.providerName} proxy access denied: insufficient credits`,
            {
              userId,
              balanceCents,
            },
          );
        }
        return {
          response: new Response("Insufficient credits", { status: 402 }),
        };
      }
      return { response: null, userId, bodyBuffer, model };
    } catch (err) {
      console.error(
        `Failed to verify ${config.providerName} proxy request`,
        err,
      );
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
    return handler(request, args, {
      userId: authResult.userId,
      bodyBuffer: authResult.bodyBuffer,
      model: authResult.model,
    });
  }

  async function GET(request: NextRequest, args: HandlerArgs) {
    return handleWithAuth(request, args, proxyRequest);
  }
  async function POST(request: NextRequest, args: HandlerArgs) {
    return handleWithAuth(request, args, proxyRequest);
  }
  async function PUT(request: NextRequest, args: HandlerArgs) {
    return handleWithAuth(request, args, proxyRequest);
  }
  async function PATCH(request: NextRequest, args: HandlerArgs) {
    return handleWithAuth(request, args, proxyRequest);
  }
  async function DELETE(request: NextRequest, args: HandlerArgs) {
    return handleWithAuth(request, args, proxyRequest);
  }
  async function OPTIONS(request: NextRequest) {
    const origin = request.headers.get("origin");
    const allowOrigin = origin ?? "*";
    const allowHeaders =
      request.headers.get("access-control-request-headers") ??
      "authorization, content-type, x-daemon-token";

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

  return { GET, POST, PUT, PATCH, DELETE, OPTIONS };
}
