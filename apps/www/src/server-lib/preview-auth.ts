import { redis } from "@/lib/redis";
import { env } from "@terragon/env/apps-www";
import {
  previewBroadcastSchemaVersion,
  previewKeyNamespaces,
  previewSessionTTLSeconds,
  previewTokenAudiences,
  previewTokenIssuer,
  type PreviewAuthClaimTuple,
  type PreviewBroadcastAuthClaimTuple,
  type PreviewCookieAuthClaimTuple,
  type PreviewExchangeAuthClaimTuple,
  type PreviewPinnedUpstreamIps,
  type PreviewSecurityReason,
  type PreviewTokenNamespace,
  type PreviewUpstreamOriginClaims,
} from "@terragon/shared/types/preview";
import { decodeProtectedHeader, jwtVerify, SignJWT } from "jose";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";

const encoder = new TextEncoder();
const CLOCK_SKEW_SECONDS = 60;
const EXCHANGE_MAX_TTL_SECONDS = 300;
const BROADCAST_TTL_SECONDS = 60;

const PREVIEW_KEY_ROOT = "terragon:v1:preview:keys";
const PREVIEW_EXCHANGE_JTI_PREFIX = "terragon:v1:preview:exchange:jti:";
const PREVIEW_EXCHANGE_NONCE_PREFIX = "terragon:v1:preview:exchange:nonce:";
const PREVIEW_BROADCAST_JTI_PREFIX = "terragon:v1:preview:broadcast:jti:";

export class PreviewAuthError extends Error {
  constructor(
    public readonly reason: PreviewSecurityReason,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "PreviewAuthError";
  }
}

type ClientIpSource = "x-vercel-ip" | "x-forwarded-for" | "remote-address";

export function getClientIpFromRequest(request: Request): {
  ip: string;
  source: ClientIpSource;
} {
  const vercelIp = request.headers.get("x-vercel-ip")?.trim();
  if (vercelIp) {
    return { ip: vercelIp, source: "x-vercel-ip" };
  }

  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const firstIp = forwarded.split(",")[0]?.trim();
    if (firstIp) {
      return { ip: firstIp, source: "x-forwarded-for" };
    }
  }

  return { ip: "127.0.0.1", source: "remote-address" };
}

function getDefaultKid(namespace: PreviewTokenNamespace): string {
  return `${namespace}-v1`;
}

function toKey(secret: string): Uint8Array {
  return encoder.encode(secret);
}

function fallbackSecret(namespace: PreviewTokenNamespace, kid: string): string {
  return createHash("sha256")
    .update(`${env.INTERNAL_SHARED_SECRET}:${namespace}:${kid}`)
    .digest("hex");
}

async function getKid(
  namespace: PreviewTokenNamespace,
  which: "active" | "prev",
): Promise<string | null> {
  const key = `${PREVIEW_KEY_ROOT}:${namespace}:${which}_kid`;
  const value = await redis.get<string>(key);
  if (!value) {
    return which === "active" ? getDefaultKid(namespace) : null;
  }
  return value;
}

async function getSecret(
  namespace: PreviewTokenNamespace,
  kid: string,
): Promise<string> {
  const key = `${PREVIEW_KEY_ROOT}:${namespace}:${kid}`;
  const stored = await redis.get<string>(key);
  return stored || fallbackSecret(namespace, kid);
}

async function getSigningMaterial(namespace: PreviewTokenNamespace): Promise<{
  kid: string;
  key: Uint8Array;
}> {
  const kid = (await getKid(namespace, "active")) ?? getDefaultKid(namespace);
  const secret = await getSecret(namespace, kid);
  return { kid, key: toKey(secret) };
}

async function getVerificationMaterial(
  namespace: PreviewTokenNamespace,
): Promise<Array<{ kid: string; key: Uint8Array }>> {
  const [activeKid, prevKid] = await Promise.all([
    getKid(namespace, "active"),
    getKid(namespace, "prev"),
  ]);

  const candidates = [activeKid, prevKid].filter(
    (value): value is string => !!value,
  );

  const uniqueCandidates = [...new Set(candidates)];
  if (uniqueCandidates.length === 0) {
    uniqueCandidates.push(getDefaultKid(namespace));
  }

  const materials = await Promise.all(
    uniqueCandidates.map(async (kid) => ({
      kid,
      key: toKey(await getSecret(namespace, kid)),
    })),
  );

  return materials;
}

async function signPreviewToken({
  namespace,
  audience,
  claims,
  expiresInSeconds,
  jti,
}: {
  namespace: PreviewTokenNamespace;
  audience: string;
  claims: Record<string, unknown>;
  expiresInSeconds: number;
  jti: string;
}): Promise<string> {
  const { kid, key } = await getSigningMaterial(namespace);

  return await new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256", kid })
    .setIssuer(previewTokenIssuer)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(`${expiresInSeconds}s`)
    .setJti(jti)
    .sign(key);
}

async function verifyPreviewToken({
  namespace,
  audience,
  token,
}: {
  namespace: PreviewTokenNamespace;
  audience: string;
  token: string;
}): Promise<Record<string, unknown> & { jti: string }> {
  const header = decodeProtectedHeader(token);
  const tokenKid = header.kid;
  if (!tokenKid) {
    throw new PreviewAuthError(
      "signature_mismatch",
      401,
      "Preview token is missing kid",
    );
  }

  const keys = await getVerificationMaterial(namespace);
  const keyMaterial = keys.find((key) => key.kid === tokenKid);
  if (!keyMaterial) {
    throw new PreviewAuthError(
      "signature_mismatch",
      401,
      "Preview token kid is not recognized",
    );
  }

  try {
    const { payload } = await jwtVerify(token, keyMaterial.key, {
      issuer: previewTokenIssuer,
      audience,
      clockTolerance: CLOCK_SKEW_SECONDS,
    });

    if (!payload.jti || typeof payload.jti !== "string") {
      throw new PreviewAuthError(
        "signature_mismatch",
        401,
        "Preview token is missing jti",
      );
    }

    return payload as Record<string, unknown> & { jti: string };
  } catch (error) {
    if (error instanceof PreviewAuthError) {
      throw error;
    }
    throw new PreviewAuthError(
      "signature_mismatch",
      401,
      "Preview token verification failed",
    );
  }
}

function parseClaimString(
  payload: Record<string, unknown>,
  key: string,
): string {
  const value = payload[key];
  if (typeof value !== "string" || !value) {
    throw new PreviewAuthError(
      "binding_mismatch",
      403,
      `Preview token claim ${key} is invalid`,
    );
  }
  return value;
}

function parseClaimNumber(
  payload: Record<string, unknown>,
  key: string,
): number {
  const value = payload[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new PreviewAuthError(
      "binding_mismatch",
      403,
      `Preview token claim ${key} is invalid`,
    );
  }
  return value;
}

function parseClaimSandboxProvider(
  payload: Record<string, unknown>,
): PreviewAuthClaimTuple["sandboxProvider"] {
  return parseClaimString(
    payload,
    "sandboxProvider",
  ) as PreviewAuthClaimTuple["sandboxProvider"];
}

function parsePreviewClaimTuple(
  payload: Record<string, unknown>,
): PreviewAuthClaimTuple {
  return {
    previewSessionId: parseClaimString(payload, "previewSessionId"),
    threadId: parseClaimString(payload, "threadId"),
    threadChatId: parseClaimString(payload, "threadChatId"),
    runId: parseClaimString(payload, "runId"),
    userId: parseClaimString(payload, "userId"),
    codesandboxId: parseClaimString(payload, "codesandboxId"),
    sandboxProvider: parseClaimSandboxProvider(payload),
  };
}

async function consumeSingleUseValue({
  key,
  ttlSeconds,
}: {
  key: string;
  ttlSeconds: number;
}): Promise<boolean> {
  try {
    const result = await redis.set(key, "1", { nx: true, ex: ttlSeconds });
    return result === "OK";
  } catch (error) {
    console.error("Preview replay guard unavailable", { key, error });
    throw new PreviewAuthError(
      "cache_unavailable",
      503,
      "Preview replay cache is unavailable",
    );
  }
}

export async function consumePreviewBroadcastJti({
  jti,
}: {
  jti: string;
}): Promise<void> {
  const consumed = await consumeSingleUseValue({
    key: `${PREVIEW_BROADCAST_JTI_PREFIX}${jti}`,
    ttlSeconds: BROADCAST_TTL_SECONDS,
  });

  if (!consumed) {
    throw new PreviewAuthError(
      "token_replay",
      409,
      "Preview broadcast token has already been used",
    );
  }
}

export async function mintPreviewExchangeToken({
  claims,
  nonce,
  jti,
  expiresInSeconds = EXCHANGE_MAX_TTL_SECONDS,
}: {
  claims: PreviewAuthClaimTuple;
  nonce: string;
  jti: string;
  expiresInSeconds?: number;
}): Promise<string> {
  const ttl = Math.min(expiresInSeconds, EXCHANGE_MAX_TTL_SECONDS);

  return await signPreviewToken({
    namespace: previewKeyNamespaces.exchange,
    audience: previewTokenAudiences.exchange,
    claims: {
      ...claims,
      nonce,
    },
    expiresInSeconds: ttl,
    jti,
  });
}

export async function verifyAndConsumePreviewExchangeToken({
  token,
  expectedPreviewSessionId,
}: {
  token: string;
  expectedPreviewSessionId?: string;
}): Promise<PreviewExchangeAuthClaimTuple & { jti: string }> {
  const payload = await verifyPreviewToken({
    namespace: previewKeyNamespaces.exchange,
    audience: previewTokenAudiences.exchange,
    token,
  });

  const claims = parsePreviewClaimTuple(payload);
  const nonce = parseClaimString(payload, "nonce");
  const issuedAt = parseClaimNumber(payload, "iat");
  const expiresAt = parseClaimNumber(payload, "exp");

  if (
    expiresAt <= issuedAt ||
    expiresAt - issuedAt > EXCHANGE_MAX_TTL_SECONDS
  ) {
    throw new PreviewAuthError(
      "binding_mismatch",
      403,
      "Preview exchange token lifetime is invalid",
    );
  }

  if (
    expectedPreviewSessionId &&
    claims.previewSessionId !== expectedPreviewSessionId
  ) {
    throw new PreviewAuthError(
      "binding_mismatch",
      403,
      "Preview session binding does not match",
    );
  }

  const [jtiConsumed, nonceConsumed] = await Promise.all([
    consumeSingleUseValue({
      key: `${PREVIEW_EXCHANGE_JTI_PREFIX}${payload.jti}`,
      ttlSeconds: EXCHANGE_MAX_TTL_SECONDS,
    }),
    consumeSingleUseValue({
      key: `${PREVIEW_EXCHANGE_NONCE_PREFIX}${nonce}`,
      ttlSeconds: EXCHANGE_MAX_TTL_SECONDS,
    }),
  ]);

  if (!jtiConsumed || !nonceConsumed) {
    throw new PreviewAuthError(
      "token_replay",
      409,
      "Preview exchange token has already been used",
    );
  }

  return {
    ...claims,
    nonce,
    jti: payload.jti,
  };
}

export async function mintPreviewCookieToken({
  claims,
  jti,
}: {
  claims: PreviewCookieAuthClaimTuple;
  jti: string;
}): Promise<string> {
  return await signPreviewToken({
    namespace: previewKeyNamespaces.cookie,
    audience: previewTokenAudiences.cookie,
    claims,
    expiresInSeconds: previewSessionTTLSeconds,
    jti,
  });
}

export async function verifyPreviewCookieToken({
  token,
}: {
  token: string;
}): Promise<PreviewCookieAuthClaimTuple & { jti: string }> {
  const payload = await verifyPreviewToken({
    namespace: previewKeyNamespaces.cookie,
    audience: previewTokenAudiences.cookie,
    token,
  });

  return {
    ...parsePreviewClaimTuple(payload),
    revocationVersion: parseClaimNumber(payload, "revocationVersion"),
    jti: payload.jti,
  };
}

export async function mintPreviewBroadcastToken({
  claims,
  jti,
  expiresInSeconds = BROADCAST_TTL_SECONDS,
}: {
  claims: PreviewBroadcastAuthClaimTuple;
  jti: string;
  expiresInSeconds?: number;
}): Promise<string> {
  return await signPreviewToken({
    namespace: previewKeyNamespaces.broadcast,
    audience: previewTokenAudiences.broadcast,
    claims,
    expiresInSeconds,
    jti,
  });
}

export async function verifyPreviewBroadcastToken({
  token,
}: {
  token: string;
}): Promise<PreviewBroadcastAuthClaimTuple & { jti: string }> {
  const payload = await verifyPreviewToken({
    namespace: previewKeyNamespaces.broadcast,
    audience: previewTokenAudiences.broadcast,
    token,
  });

  const tuple = parsePreviewClaimTuple(payload);
  const schemaVersion = parseClaimNumber(payload, "schemaVersion");
  const channelType = parseClaimString(payload, "channelType");

  if (
    schemaVersion !== previewBroadcastSchemaVersion ||
    channelType !== "preview"
  ) {
    throw new PreviewAuthError(
      "binding_mismatch",
      403,
      "Preview broadcast token channel metadata is invalid",
    );
  }

  return {
    ...tuple,
    schemaVersion,
    channelType: "preview",
    jti: payload.jti,
  };
}

export async function mintPreviewUpstreamOriginToken({
  claims,
  jti,
  expiresInSeconds = previewSessionTTLSeconds,
}: {
  claims: PreviewUpstreamOriginClaims;
  jti: string;
  expiresInSeconds?: number;
}): Promise<string> {
  return await signPreviewToken({
    namespace: previewKeyNamespaces.origin,
    audience: previewTokenAudiences.origin,
    claims,
    expiresInSeconds,
    jti,
  });
}

export async function verifyPreviewUpstreamOriginToken({
  token,
}: {
  token: string;
}): Promise<PreviewUpstreamOriginClaims & { jti: string }> {
  const payload = await verifyPreviewToken({
    namespace: previewKeyNamespaces.origin,
    audience: previewTokenAudiences.origin,
    token,
  });

  return {
    scheme: parseClaimString(payload, "scheme") as "http" | "https",
    host: parseClaimString(payload, "host"),
    port: parseClaimNumber(payload, "port"),
    pinningMode: parseClaimString(
      payload,
      "pinningMode",
    ) as PreviewUpstreamOriginClaims["pinningMode"],
    exp: parseClaimNumber(payload, "exp"),
    previewSessionId: parseClaimString(payload, "previewSessionId"),
    revocationVersion: parseClaimNumber(payload, "revocationVersion"),
    jti: payload.jti,
  };
}

export function mapPreviewAuthError(error: unknown): {
  status: number;
  code: PreviewSecurityReason | "unknown";
  message: string;
} {
  if (error instanceof PreviewAuthError) {
    return {
      status: error.status,
      code: error.reason,
      message: error.message,
    };
  }

  return {
    status: 500,
    code: "unknown",
    message: "Unexpected preview auth error",
  };
}

export function getPreviewCookieName(previewSessionId: string): string {
  return `terragon_preview_${previewSessionId}`;
}

export function isPreviewSessionExpired(expiresAt: Date | null): boolean {
  if (!expiresAt) {
    return false;
  }
  return expiresAt.getTime() <= Date.now();
}

export function buildPinnedUpstreamIpsFromOrigin(
  origin: URL,
  pinningMode: PreviewPinnedUpstreamIps["pinningMode"],
): PreviewPinnedUpstreamIps {
  return {
    addressesV4: [],
    addressesV6: [],
    cnameChain: [origin.hostname],
    ttlSeconds: 60,
    resolvedAt: new Date().toISOString(),
    pinningMode,
  };
}

export async function resolvePinnedUpstreamIpsFromOrigin(
  origin: URL,
  pinningMode: PreviewPinnedUpstreamIps["pinningMode"],
): Promise<PreviewPinnedUpstreamIps> {
  try {
    const addresses = await lookup(origin.hostname, {
      all: true,
      verbatim: true,
    });
    const addressesV4 = [
      ...new Set(addresses.filter((a) => a.family === 4).map((a) => a.address)),
    ];
    const addressesV6 = [
      ...new Set(addresses.filter((a) => a.family === 6).map((a) => a.address)),
    ];

    return {
      addressesV4,
      addressesV6,
      cnameChain: [origin.hostname],
      ttlSeconds: 60,
      resolvedAt: new Date().toISOString(),
      pinningMode,
    };
  } catch (error) {
    console.error("Unable to resolve preview upstream host for pinning", {
      host: origin.hostname,
      error,
    });
    return buildPinnedUpstreamIpsFromOrigin(origin, pinningMode);
  }
}

export function createPreviewServiceUnavailablePayload() {
  return {
    code: "cache_unavailable",
    retryAfterMs: 3000,
    backoffHint: "retry_with_backoff",
  };
}
