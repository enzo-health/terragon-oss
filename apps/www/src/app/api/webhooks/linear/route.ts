import crypto from "crypto";
import { env } from "@terragon/env/apps-www";
import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { handleAgentSessionEvent, handleAppUserNotification } from "./handlers";
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
  const a = Buffer.from(hmac);
  const b = Buffer.from(signature);
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
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

  const deliveryId = req.headers.get("Linear-Delivery-Id") ?? undefined;

  console.log(
    "[linear webhook] Received event type:",
    payload.type,
    payload.action,
    { deliveryId },
  );

  if (payload.type === "AgentSessionEvent") {
    // Primary trigger: AgentSessionEvent
    // `created` → create thread (emits thought synchronously within 10s SLA)
    // `prompted` → route follow-up to existing thread
    await handleAgentSessionEvent(
      payload as unknown as Parameters<typeof handleAgentSessionEvent>[0],
      deliveryId,
    );
    return new Response("ok", { status: 200 });
  }

  if (payload.type === "AppUserNotification") {
    // Log only — do NOT create threads (no agentSessionId available)
    waitUntil(
      handleAppUserNotification(
        payload as unknown as Parameters<typeof handleAppUserNotification>[0],
      ).catch((err) => {
        console.error(
          "[linear webhook] Error handling AppUserNotification",
          err,
        );
      }),
    );
    return new Response("ok", { status: 200 });
  }

  // Other event types — return 200, skip
  return new Response("ok", { status: 200 });
}
