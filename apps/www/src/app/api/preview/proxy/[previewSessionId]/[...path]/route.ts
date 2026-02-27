import { db } from "@/lib/db";
import {
  enforcePreviewRateLimit,
  PreviewRateLimitError,
} from "@/lib/rate-limit";
import { redis } from "@/lib/redis";
import {
  assertPreviewRepoAccess,
  getClientIpFromRequest,
  getPreviewCookieName,
  mapPreviewAuthError,
  verifyPreviewCookieToken,
  verifyPreviewUpstreamOriginToken,
} from "@/server-lib/preview-auth";
import { emitPreviewAccessDenied } from "@/server-lib/preview-observability";
import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { previewSession } from "@terragon/shared/db/schema";
import { getFeatureFlagForUser } from "@terragon/shared/model/feature-flags";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { PreviewPinnedUpstreamIps } from "@terragon/shared/types/preview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PROXY_BODY_BYTES = 2 * 1024 * 1024;
const MAX_CONCURRENT_PROXY_REQUESTS = 16;
const PROXY_TIMEOUT_MS = 30_000;
const PROXY_SEMAPHORE_TTL_SECONDS = 60;

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "te",
  "upgrade",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "transfer-encoding",
  "trailer",
]);

const BLOCKED_UPSTREAM_RESPONSE_HEADERS = new Set([
  "set-cookie",
  "set-cookie2",
  "content-security-policy",
  "content-security-policy-report-only",
]);

const PREVIEW_SANDBOX_CSP =
  "sandbox allow-forms allow-modals allow-popups allow-scripts";

const FORWARDED_HEADER_ALLOWLIST = new Set([
  "accept",
  "accept-language",
  "content-type",
  "if-none-match",
  "if-modified-since",
  "user-agent",
]);

function normalizeIp(address: string): string {
  return address.trim().toLowerCase();
}

function parseIpv4MappedIpv6(address: string): string | null {
  if (!address.startsWith("::ffff:")) {
    return null;
  }

  const tail = address.slice("::ffff:".length);
  if (isIP(tail) === 4) {
    return tail;
  }

  const words = tail.split(":");
  if (words.length !== 2) {
    return null;
  }

  const [highWord, lowWord] = words;
  if (
    !highWord ||
    !lowWord ||
    !/^[\da-f]{1,4}$/i.test(highWord) ||
    !/^[\da-f]{1,4}$/i.test(lowWord)
  ) {
    return null;
  }

  const high = Number.parseInt(highWord, 16);
  const low = Number.parseInt(lowWord, 16);

  return `${(high >> 8) & 255}.${high & 255}.${(low >> 8) & 255}.${low & 255}`;
}

export function isPrivateOrLoopbackIp(address: string): boolean {
  const normalized = normalizeIp(address);
  const mappedV4 = parseIpv4MappedIpv6(normalized);
  if (mappedV4) {
    return isPrivateOrLoopbackIp(mappedV4);
  }

  const family = isIP(normalized);
  if (family === 4) {
    const parts = normalized.split(".").map((part) => Number(part));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) {
      return true;
    }

    const a = parts[0];
    const b = parts[1];
    if (a === undefined || b === undefined) {
      return true;
    }
    return (
      a === 10 ||
      a === 127 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }

  if (family === 6) {
    return (
      normalized === "::1" ||
      normalized === "::" ||
      normalized.startsWith("fc") ||
      normalized.startsWith("fd") ||
      normalized.startsWith("fe80:")
    );
  }

  return true;
}

async function resolveHostAddresses(hostname: string): Promise<string[]> {
  if (isIP(hostname)) {
    return [hostname];
  }

  const resolved = await lookup(hostname, { all: true, verbatim: true });
  return [...new Set(resolved.map((entry) => entry.address))];
}

function validatePinnedResolvedAddresses({
  addresses,
  pinned,
}: {
  addresses: string[];
  pinned: PreviewPinnedUpstreamIps | null;
}): {
  ok: boolean;
  code: "proxy_ssrf_blocked" | "proxy_denied";
  reason: string;
} {
  if (addresses.length === 0) {
    return {
      ok: false,
      code: "proxy_denied",
      reason: "Preview upstream host did not resolve to any addresses",
    };
  }

  if (addresses.some((address) => isPrivateOrLoopbackIp(address))) {
    return {
      ok: false,
      code: "proxy_ssrf_blocked",
      reason: "Preview upstream resolved to private or loopback IP space",
    };
  }

  if (!pinned) {
    return { ok: true, code: "proxy_denied", reason: "" };
  }

  if (pinned.pinningMode === "strict_ip") {
    const pinnedAddresses = new Set(
      [...pinned.addressesV4, ...pinned.addressesV6].map(normalizeIp),
    );
    if (pinnedAddresses.size === 0) {
      return {
        ok: false,
        code: "proxy_denied",
        reason:
          "Strict IP pinning is enabled but no pinned addresses were persisted",
      };
    }

    const mismatched = addresses.some(
      (address) => !pinnedAddresses.has(normalizeIp(address)),
    );
    if (mismatched) {
      return {
        ok: false,
        code: "proxy_ssrf_blocked",
        reason: "Preview upstream address set no longer matches strict pins",
      };
    }
  }

  return { ok: true, code: "proxy_denied", reason: "" };
}

function getOriginPort(url: URL): number {
  if (url.port) {
    return Number(url.port);
  }
  return url.protocol === "https:" ? 443 : 80;
}

function normalizePath(parts: string[] | undefined): string | null {
  const rawPath = (parts ?? []).join("/");
  if (!rawPath) {
    return "/";
  }

  if (
    rawPath.includes("\\") ||
    rawPath.includes("://") ||
    rawPath.startsWith("//")
  ) {
    return null;
  }

  let decodedOnce: string;
  let decodedTwice: string;
  try {
    decodedOnce = decodeURIComponent(rawPath);
    decodedTwice = decodeURIComponent(decodedOnce);
  } catch {
    return null;
  }
  if (decodedTwice.includes("..")) {
    return null;
  }

  const normalized = `/${decodedTwice.replace(/\/+/g, "/")}`;
  if (normalized.includes("/../") || normalized.endsWith("/..")) {
    return null;
  }

  return normalized;
}

function getCookieValue(request: Request, name: string): string | null {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) {
    return null;
  }

  const cookies = cookieHeader.split(";");
  for (const cookiePart of cookies) {
    const [cookieName, ...rest] = cookiePart.trim().split("=");
    if (cookieName === name) {
      return decodeURIComponent(rest.join("="));
    }
  }

  return null;
}

async function acquireProxySemaphore({
  previewSessionId,
}: {
  previewSessionId: string;
}): Promise<{ key: string; acquired: boolean }> {
  const key = `terragon:v1:preview:proxy:semaphore:${previewSessionId}`;
  const current = await redis.incr(key);
  if (current === 1) {
    await redis.expire(key, PROXY_SEMAPHORE_TTL_SECONDS);
  }

  if (current > MAX_CONCURRENT_PROXY_REQUESTS) {
    await redis.decr(key);
    return { key, acquired: false };
  }

  return { key, acquired: true };
}

async function releaseProxySemaphore(key: string): Promise<void> {
  const current = await redis.decr(key);
  if (current <= 0) {
    await redis.del(key);
  }
}

async function parseRequestBody(
  request: Request,
): Promise<Uint8Array | undefined> {
  if (request.method === "GET" || request.method === "HEAD") {
    return undefined;
  }

  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader) {
    const contentLength = Number(contentLengthHeader);
    if (
      Number.isFinite(contentLength) &&
      contentLength > MAX_PROXY_BODY_BYTES
    ) {
      throw new Response(
        JSON.stringify({
          code: "proxy_body_too_large",
          error: "Request body exceeds 2MB limit",
        }),
        {
          status: 413,
          headers: { "content-type": "application/json" },
        },
      );
    }
  }

  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > MAX_PROXY_BODY_BYTES) {
    throw new Response(
      JSON.stringify({
        code: "proxy_body_too_large",
        error: "Request body exceeds 2MB limit",
      }),
      {
        status: 413,
        headers: { "content-type": "application/json" },
      },
    );
  }
  return body;
}

function buildForwardHeaders({
  request,
  upstreamOrigin,
  normalizedPath,
  providerAuthHeaders,
}: {
  request: Request;
  upstreamOrigin: string;
  normalizedPath: string;
  providerAuthHeaders: Record<string, string>;
}): Headers {
  const headers = new Headers();

  request.headers.forEach((value, key) => {
    const lowerKey = key.toLowerCase();
    if (FORWARDED_HEADER_ALLOWLIST.has(lowerKey)) {
      headers.set(lowerKey, value);
    }
  });

  headers.set("origin", upstreamOrigin);
  headers.set("referer", `${upstreamOrigin}${normalizedPath}`);
  headers.set("accept-encoding", "identity");

  for (const [key, value] of Object.entries(providerAuthHeaders)) {
    headers.set(key, value);
  }

  return headers;
}

function enforcePreviewSandboxCsp(existing: string | null): string {
  const directives = (existing ?? "")
    .split(";")
    .map((directive) => directive.trim())
    .filter(Boolean)
    .filter((directive) => !directive.toLowerCase().startsWith("sandbox"));

  directives.push(PREVIEW_SANDBOX_CSP);
  return directives.join("; ");
}

export function sanitizeResponseHeaders(
  headers: Headers,
  proxyReqId: string,
): Headers {
  const nextHeaders = new Headers();
  headers.forEach((value, key) => {
    const lowerKey = key.toLowerCase();
    if (
      HOP_BY_HOP_HEADERS.has(lowerKey) ||
      BLOCKED_UPSTREAM_RESPONSE_HEADERS.has(lowerKey)
    ) {
      return;
    }
    nextHeaders.set(key, value);
  });

  nextHeaders.set(
    "content-security-policy",
    enforcePreviewSandboxCsp(headers.get("content-security-policy")),
  );
  nextHeaders.set("x-content-type-options", "nosniff");
  nextHeaders.set("cache-control", "no-store");
  nextHeaders.set("x-proxy-req-id", proxyReqId);

  const contentType = nextHeaders.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    nextHeaders.set("content-type", "text/event-stream");
    nextHeaders.set("cache-control", "no-cache, no-transform");
    nextHeaders.set("x-accel-buffering", "no");
  }

  return nextHeaders;
}

export async function ALL(
  request: Request,
  {
    params,
  }: {
    params: Promise<{ previewSessionId: string; path?: string[] }>;
  },
) {
  const { previewSessionId, path } = await params;
  const proxyReqId = crypto.randomUUID();
  const traceId = crypto.randomUUID();

  const normalizedPath = normalizePath(path);
  if (!normalizedPath) {
    return NextResponse.json(
      {
        code: "proxy_path_denied",
        error: "Invalid preview proxy path",
      },
      { status: 403, headers: { "x-proxy-req-id": proxyReqId } },
    );
  }

  const session = await db.query.previewSession.findFirst({
    where: eq(previewSession.previewSessionId, previewSessionId),
  });
  if (!session) {
    return NextResponse.json(
      { error: "Preview session not found" },
      { status: 404, headers: { "x-proxy-req-id": proxyReqId } },
    );
  }

  if (session.userId) {
    const isPreviewEnabled = await getFeatureFlagForUser({
      db,
      userId: session.userId,
      flagName: "sandboxPreview",
    });
    if (!isPreviewEnabled) {
      return NextResponse.json(
        { error: "Not found" },
        { status: 404, headers: { "x-proxy-req-id": proxyReqId } },
      );
    }
  }

  if (
    session.revokedAt ||
    (session.expiresAt && session.expiresAt.getTime() <= Date.now())
  ) {
    return NextResponse.json(
      { code: "expired", error: "Preview session is not active" },
      { status: 401, headers: { "x-proxy-req-id": proxyReqId } },
    );
  }

  if (session.previewRequiresWebsocket) {
    return NextResponse.json(
      { code: "ws_required", error: "Preview requires websocket transport" },
      { status: 501, headers: { "x-proxy-req-id": proxyReqId } },
    );
  }

  const cookieName = getPreviewCookieName(previewSessionId);
  const cookieToken = getCookieValue(request, cookieName);
  if (!cookieToken) {
    emitPreviewAccessDenied({
      reason: "permission_denied",
      status: 401,
      base: {
        origin: "preview_proxy",
        traceId,
        previewSessionId,
        proxyReqId,
      },
      dimensions: {
        userId: session.userId,
        repoFullName: session.repoFullName,
        sandboxProvider: session.sandboxProvider,
      },
    });
    return NextResponse.json(
      { code: "permission_denied", error: "Missing preview session cookie" },
      { status: 401, headers: { "x-proxy-req-id": proxyReqId } },
    );
  }

  let cookieClaims;
  try {
    cookieClaims = await verifyPreviewCookieToken({ token: cookieToken });
  } catch (error) {
    const mapped = mapPreviewAuthError(error);
    return NextResponse.json(
      { code: mapped.code, error: mapped.message },
      { status: mapped.status, headers: { "x-proxy-req-id": proxyReqId } },
    );
  }

  if (
    cookieClaims.previewSessionId !== session.previewSessionId ||
    cookieClaims.threadId !== session.threadId ||
    cookieClaims.threadChatId !== session.threadChatId ||
    cookieClaims.runId !== session.runId ||
    cookieClaims.userId !== session.userId ||
    cookieClaims.codesandboxId !== session.codesandboxId ||
    cookieClaims.sandboxProvider !== session.sandboxProvider
  ) {
    emitPreviewAccessDenied({
      reason: "binding_mismatch",
      status: 403,
      base: {
        origin: "preview_proxy",
        traceId,
        previewSessionId,
        threadId: session.threadId,
        threadChatId: session.threadChatId,
        runId: session.runId,
        proxyReqId,
      },
      dimensions: {
        userId: session.userId,
        repoFullName: session.repoFullName,
        sandboxProvider: session.sandboxProvider,
      },
    });
    return NextResponse.json(
      {
        code: "binding_mismatch",
        error: "Preview session cookie claims do not match",
      },
      { status: 403, headers: { "x-proxy-req-id": proxyReqId } },
    );
  }

  if (cookieClaims.revocationVersion !== session.revocationVersion) {
    return NextResponse.json(
      {
        code: "revoked",
        error: "Preview session cookie has been revoked",
      },
      { status: 401, headers: { "x-proxy-req-id": proxyReqId } },
    );
  }

  try {
    const hasAccess = await assertPreviewRepoAccess({
      userId: cookieClaims.userId,
      repoFullName: session.repoFullName,
      accessCheck: async () => session.userId === cookieClaims.userId,
    });
    if (!hasAccess) {
      emitPreviewAccessDenied({
        reason: "permission_denied",
        status: 403,
        base: {
          origin: "preview_proxy",
          traceId,
          previewSessionId,
          threadId: session.threadId,
          threadChatId: session.threadChatId,
          runId: session.runId,
          proxyReqId,
        },
        dimensions: {
          userId: session.userId,
          repoFullName: session.repoFullName,
          sandboxProvider: session.sandboxProvider,
        },
      });
      return NextResponse.json(
        {
          code: "permission_denied",
          error: "Preview repo access denied",
        },
        { status: 403, headers: { "x-proxy-req-id": proxyReqId } },
      );
    }
  } catch (error) {
    const mapped = mapPreviewAuthError(error);
    return NextResponse.json(
      { code: mapped.code, error: mapped.message },
      { status: mapped.status, headers: { "x-proxy-req-id": proxyReqId } },
    );
  }

  if (!session.upstreamOrigin) {
    return NextResponse.json(
      {
        code: "proxy_denied",
        error: "Preview upstream is not ready",
      },
      { status: 409, headers: { "x-proxy-req-id": proxyReqId } },
    );
  }

  let upstreamOrigin: URL;
  try {
    upstreamOrigin = new URL(session.upstreamOrigin);
  } catch {
    return NextResponse.json(
      {
        code: "proxy_denied",
        error: "Preview upstream origin is invalid",
      },
      { status: 409, headers: { "x-proxy-req-id": proxyReqId } },
    );
  }

  if (session.upstreamOriginToken) {
    try {
      const originClaims = await verifyPreviewUpstreamOriginToken({
        token: session.upstreamOriginToken,
      });
      const expectedScheme =
        upstreamOrigin.protocol === "https:" ? "https" : "http";
      const expectedPort = getOriginPort(upstreamOrigin);
      const expectedPinningMode =
        session.pinnedUpstreamIpsJson?.pinningMode ?? originClaims.pinningMode;
      if (
        originClaims.previewSessionId !== session.previewSessionId ||
        originClaims.revocationVersion !== session.revocationVersion ||
        originClaims.scheme !== expectedScheme ||
        originClaims.host !== upstreamOrigin.hostname ||
        originClaims.port !== expectedPort ||
        originClaims.pinningMode !== expectedPinningMode
      ) {
        return NextResponse.json(
          {
            code: "binding_mismatch",
            error: "Preview upstream origin token claims do not match",
          },
          { status: 403, headers: { "x-proxy-req-id": proxyReqId } },
        );
      }
    } catch (error) {
      const mapped = mapPreviewAuthError(error);
      return NextResponse.json(
        { code: mapped.code, error: mapped.message },
        { status: mapped.status, headers: { "x-proxy-req-id": proxyReqId } },
      );
    }
  }

  let resolvedUpstreamAddresses: string[];
  try {
    resolvedUpstreamAddresses = await resolveHostAddresses(
      upstreamOrigin.hostname,
    );
  } catch (error) {
    console.error("Preview upstream DNS resolution failed", {
      proxyReqId,
      previewSessionId,
      host: upstreamOrigin.hostname,
      error,
    });
    return NextResponse.json(
      {
        code: "proxy_denied",
        error: "Preview upstream DNS resolution failed",
      },
      { status: 502, headers: { "x-proxy-req-id": proxyReqId } },
    );
  }

  const addressValidation = validatePinnedResolvedAddresses({
    addresses: resolvedUpstreamAddresses,
    pinned: session.pinnedUpstreamIpsJson ?? null,
  });
  if (!addressValidation.ok) {
    return NextResponse.json(
      {
        code: addressValidation.code,
        error: addressValidation.reason,
      },
      {
        status: addressValidation.code === "proxy_denied" ? 502 : 403,
        headers: { "x-proxy-req-id": proxyReqId },
      },
    );
  }

  const { ip } = getClientIpFromRequest(request);
  try {
    await enforcePreviewRateLimit({
      scope: "proxy",
      ip,
      previewSessionId,
    });
  } catch (error) {
    if (error instanceof PreviewRateLimitError) {
      return NextResponse.json(
        {
          code: "rate_limited",
          limiter: error.dimension,
          nextAllowedAt: error.nextAllowedAt,
        },
        {
          status: 429,
          headers: {
            "Retry-After": "1",
            "x-proxy-req-id": proxyReqId,
          },
        },
      );
    }
    throw error;
  }

  const semaphore = await acquireProxySemaphore({ previewSessionId });
  if (!semaphore.acquired) {
    return NextResponse.json(
      {
        code: "rate_limited",
        limiter: "session",
        nextAllowedAt: new Date(Date.now() + 1000).toISOString(),
      },
      {
        status: 429,
        headers: {
          "Retry-After": "1",
          "x-proxy-req-id": proxyReqId,
        },
      },
    );
  }

  try {
    const body = await parseRequestBody(request);

    const targetUrl = new URL(
      `${normalizedPath}${new URL(request.url).search}`,
      upstreamOrigin,
    );
    if (targetUrl.origin !== upstreamOrigin.origin) {
      return NextResponse.json(
        {
          code: "proxy_ssrf_blocked",
          error: "Proxy target origin mismatch",
        },
        { status: 403, headers: { "x-proxy-req-id": proxyReqId } },
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROXY_TIMEOUT_MS);

    const forwardHeaders = buildForwardHeaders({
      request,
      upstreamOrigin: upstreamOrigin.origin,
      normalizedPath,
      providerAuthHeaders: session.providerAuthHeadersJson ?? {},
    });

    let upstreamResponse: Response;
    try {
      upstreamResponse = await fetch(targetUrl, {
        method: request.method,
        headers: forwardHeaders,
        body,
        redirect: "manual",
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    const responseHeaders = sanitizeResponseHeaders(
      upstreamResponse.headers,
      proxyReqId,
    );
    return new Response(upstreamResponse.body, {
      status: upstreamResponse.status,
      headers: responseHeaders,
    });
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }

    console.error("Preview proxy request failed", {
      proxyReqId,
      previewSessionId,
      error,
    });
    return NextResponse.json(
      {
        code: "proxy_denied",
        error: "Preview proxy request failed",
      },
      { status: 502, headers: { "x-proxy-req-id": proxyReqId } },
    );
  } finally {
    await releaseProxySemaphore(semaphore.key);
  }
}

export const GET = ALL;
export const POST = ALL;
export const PUT = ALL;
export const PATCH = ALL;
export const DELETE = ALL;
export const OPTIONS = ALL;
