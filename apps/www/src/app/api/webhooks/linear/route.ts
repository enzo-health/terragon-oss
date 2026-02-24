import { env } from "@terragon/env/apps-www";
import { NextRequest, NextResponse } from "next/server";
import { waitUntil } from "@vercel/functions";
import { handleCommentCreated } from "./handlers";
import {
  LinearWebhookClient,
  LINEAR_WEBHOOK_SIGNATURE_HEADER,
  LINEAR_WEBHOOK_TS_HEADER,
} from "@linear/sdk/webhooks";

function verifyLinearSignature(req: NextRequest, rawBody: string): boolean {
  if (!env.LINEAR_WEBHOOK_SECRET) {
    console.warn(
      "[linear webhook] LINEAR_WEBHOOK_SECRET is not set, skipping verification",
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
  } catch {
    // Fallback to manual HMAC-SHA256 verification
    return verifyLinearSignatureManual(rawBody, signature);
  }
}

function verifyLinearSignatureManual(
  rawBody: string,
  signature: string,
): boolean {
  const crypto = require("crypto") as typeof import("crypto");
  const hmac = crypto
    .createHmac("sha256", env.LINEAR_WEBHOOK_SECRET)
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

  const payload = JSON.parse(rawBody);

  console.log(
    "[linear webhook] Received event type:",
    payload.type,
    payload.action,
  );

  // Only process Comment create events
  if (payload.type !== "Comment" || payload.action !== "create") {
    return new Response("ok", { status: 200 });
  }

  // Return 200 immediately, process asynchronously
  waitUntil(
    handleCommentCreated(payload).catch((error) => {
      console.error("[linear webhook] Error processing comment:", error);
    }),
  );

  return new Response("ok", { status: 200 });
}
