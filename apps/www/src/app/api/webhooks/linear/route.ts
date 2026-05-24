import crypto from "crypto";
import { env } from "@terragon/env/apps-www";
import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import {
  handleAgentSessionEvent,
  handleAppUserNotification,
  handleOAuthAppRevoked,
  handlePermissionChange,
  type AgentSessionEventPayload,
  type AppUserNotificationPayload,
  type OAuthAppRevokedPayload,
  type PermissionChangePayload,
} from "./handlers";
import {
  LinearWebhookClient,
  LINEAR_WEBHOOK_SIGNATURE_HEADER,
  LINEAR_WEBHOOK_TS_HEADER,
} from "@linear/sdk/webhooks";

/**
 * Returns true if verification passes, false if it fails.
 * In dev (no secret configured), logs a warning and allows through.
 * In production (VERCEL_ENV set), fails closed if secret is missing.
 */
function verifyLinearSignature(req: NextRequest, rawBody: string): boolean {
  if (!env.LINEAR_WEBHOOK_SECRET) {
    // Fail closed in production; allow in development for testing
    if (process.env.VERCEL_ENV) {
      console.error(
        "[linear webhook] LINEAR_WEBHOOK_SECRET is not set in production, rejecting",
      );
      return false;
    }
    console.warn(
      "[linear webhook] LINEAR_WEBHOOK_SECRET is not set, skipping verification (dev only)",
    );
    return true;
  }

  const signature = req.headers.get(LINEAR_WEBHOOK_SIGNATURE_HEADER);
  if (!signature) {
    return false;
  }

  const timestamp = req.headers.get(LINEAR_WEBHOOK_TS_HEADER);

  try {
    const webhookClient = new LinearWebhookClient(env.LINEAR_WEBHOOK_SECRET);
    return webhookClient.verify(
      Buffer.from(rawBody, "utf-8"),
      signature,
      timestamp ?? undefined,
    );
  } catch (error) {
    // Only fallback to manual verification for SDK runtime incompatibility
    // (e.g. constructor/method not available), NOT for signature validation failures.
    if (
      error instanceof TypeError ||
      (error instanceof Error && error.message.includes("is not a function"))
    ) {
      console.warn(
        "[linear webhook] SDK verification not available, using manual HMAC fallback",
      );
      return verifyLinearSignatureManual(
        rawBody,
        signature,
        env.LINEAR_WEBHOOK_SECRET,
        timestamp,
      );
    }
    // Verification failed (bad signature, timestamp, etc) - reject
    return false;
  }
}

/**
 * Manual HMAC fallback for environments where the LinearWebhookClient is unavailable.
 * Mirrors Linear's signature scheme: HMAC-SHA256 over rawBody, with timestamp replay
 * protection (rejects if timestamp is absent or outside ±5 minutes).
 */
function verifyLinearSignatureManual(
  rawBody: string,
  signature: string,
  secret: string,
  timestamp: string | null,
): boolean {
  // Enforce timestamp presence and replay window
  if (!timestamp) {
    console.warn(
      "[linear webhook] Manual verification: missing timestamp header, rejecting",
    );
    return false;
  }
  const tsMs = Number(timestamp) * 1000;
  if (isNaN(tsMs)) {
    console.warn(
      "[linear webhook] Manual verification: non-numeric timestamp, rejecting",
    );
    return false;
  }
  const skewMs = Math.abs(Date.now() - tsMs);
  if (skewMs > 5 * 60 * 1000) {
    console.warn(
      "[linear webhook] Manual verification: timestamp outside ±5 min window, rejecting",
      { skewMs },
    );
    return false;
  }

  const hmac = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf-8")
    .digest("hex");

  // Normalise: strip optional "sha256=" prefix (defensive; Linear sends raw hex).
  const normSignature = signature.startsWith("sha256=")
    ? signature.slice(7)
    : signature;

  // Compare as hex-decoded bytes for constant-time safety.
  // Both strings must be valid hex; if not, bail early.
  let a: Buffer;
  let b: Buffer;
  try {
    a = Buffer.from(hmac, "hex");
    b = Buffer.from(normSignature, "hex");
  } catch {
    return false;
  }
  if (a.length === 0 || a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function getStringField(
  payload: Record<string, unknown>,
  field: string,
): string | null {
  const value = payload[field];
  return typeof value === "string" ? value : null;
}

function getStringArrayField(
  payload: Record<string, unknown>,
  field: string,
): string[] | null {
  const value = payload[field];
  return Array.isArray(value) &&
    value.every((entry) => typeof entry === "string")
    ? value
    : null;
}

function getBooleanField(
  payload: Record<string, unknown>,
  field: string,
): boolean | null {
  const value = payload[field];
  return typeof value === "boolean" ? value : null;
}

function isObject(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function hasAgentSessionId(payload: object): boolean {
  const agentSession = Reflect.get(payload, "agentSession");
  return (
    isObject(agentSession) &&
    typeof Reflect.get(agentSession, "id") === "string"
  );
}

function isAgentSessionEventPayload(
  payload: unknown,
): payload is AgentSessionEventPayload {
  if (!isObject(payload)) {
    return false;
  }
  return (
    Reflect.get(payload, "type") === "AgentSessionEvent" &&
    typeof Reflect.get(payload, "action") === "string" &&
    typeof Reflect.get(payload, "organizationId") === "string" &&
    hasAgentSessionId(payload)
  );
}

function isAppUserNotificationPayload(
  payload: unknown,
): payload is AppUserNotificationPayload {
  if (!isObject(payload)) {
    return false;
  }
  return (
    Reflect.get(payload, "type") === "AppUserNotification" &&
    typeof Reflect.get(payload, "organizationId") === "string"
  );
}

function parsePermissionChangePayload(
  payload: Record<string, unknown>,
): PermissionChangePayload | null {
  const organizationId = getStringField(payload, "organizationId");
  const createdAt = getStringField(payload, "createdAt");
  const canAccessAllPublicTeams = getBooleanField(
    payload,
    "canAccessAllPublicTeams",
  );
  const addedTeamIds = getStringArrayField(payload, "addedTeamIds");
  const removedTeamIds = getStringArrayField(payload, "removedTeamIds");

  if (
    payload.type !== "PermissionChange" ||
    payload.action !== "teamAccessChanged" ||
    !organizationId ||
    !createdAt ||
    canAccessAllPublicTeams === null ||
    !addedTeamIds ||
    !removedTeamIds
  ) {
    return null;
  }

  return {
    type: "PermissionChange",
    action: "teamAccessChanged",
    createdAt,
    organizationId,
    canAccessAllPublicTeams,
    addedTeamIds,
    removedTeamIds,
  };
}

function parseOAuthAppRevokedPayload(
  payload: Record<string, unknown>,
): OAuthAppRevokedPayload | null {
  const organizationId = getStringField(payload, "organizationId");
  if (
    payload.type !== "OAuthApp" ||
    payload.action !== "revoked" ||
    !organizationId
  ) {
    return null;
  }
  return {
    type: "OAuthApp",
    action: "revoked",
    organizationId,
  };
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();

  if (!verifyLinearSignature(req, rawBody)) {
    console.error("[linear webhook] Invalid signature");
    return NextResponse.json(
      { success: false, error: "Invalid signature" },
      { status: 401 },
    );
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    console.error("[linear webhook] Invalid JSON payload");
    return NextResponse.json(
      { success: false, error: "Invalid JSON" },
      { status: 400 },
    );
  }

  const deliveryId =
    req.headers.get("Linear-Delivery") ??
    req.headers.get("Linear-Delivery-Id") ??
    undefined;

  console.log(
    "[linear webhook] Received event type:",
    payload.type,
    payload.action,
    { deliveryId },
  );

  if (payload.type === "AgentSessionEvent") {
    if (!isAgentSessionEventPayload(payload)) {
      console.warn("[linear webhook] Invalid AgentSessionEvent payload");
      return new Response("ok", { status: 200 });
    }

    // Primary trigger: AgentSessionEvent
    // `created` → create thread (emits thought synchronously within 10s SLA)
    // `prompted` → route follow-up to existing thread
    await handleAgentSessionEvent(payload, deliveryId);
    return new Response("ok", { status: 200 });
  }

  if (payload.type === "AppUserNotification") {
    if (!isAppUserNotificationPayload(payload)) {
      console.warn("[linear webhook] Invalid AppUserNotification payload");
      return new Response("ok", { status: 200 });
    }

    // Inbox notifications — agent was mentioned, unassigned, reacted to, etc.
    waitUntil(
      handleAppUserNotification(payload).catch((err) => {
        console.error(
          "[linear webhook] Error handling AppUserNotification",
          err,
        );
      }),
    );
    return new Response("ok", { status: 200 });
  }

  if (payload.type === "PermissionChange") {
    const permissionChangePayload = parsePermissionChangePayload(payload);
    if (!permissionChangePayload) {
      console.warn("[linear webhook] Invalid PermissionChange payload");
      return new Response("ok", { status: 200 });
    }

    // Team access gained/lost for the agent
    waitUntil(
      handlePermissionChange(permissionChangePayload).catch((err) => {
        console.error("[linear webhook] Error handling PermissionChange", err);
      }),
    );
    return new Response("ok", { status: 200 });
  }

  if (payload.type === "OAuthApp" && payload.action === "revoked") {
    const oauthAppRevokedPayload = parseOAuthAppRevokedPayload(payload);
    if (!oauthAppRevokedPayload) {
      console.warn("[linear webhook] Invalid OAuthApp revoked payload");
      return new Response("ok", { status: 200 });
    }

    // OAuth app was revoked — deactivate the installation
    waitUntil(
      handleOAuthAppRevoked(oauthAppRevokedPayload).catch((err) => {
        console.error("[linear webhook] Error handling OAuthApp revoked", err);
      }),
    );
    return new Response("ok", { status: 200 });
  }

  // Other event types — return 200, skip
  return new Response("ok", { status: 200 });
}
