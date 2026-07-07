import crypto from "crypto";
import { env } from "@terragon/env/apps-www";
import { NextRequest, NextResponse } from "next/server";
import { handleAppMentionEvent } from "./handlers";
import { waitUntil } from "@vercel/functions";

function verifySlackSignature(req: NextRequest, body: string): boolean {
  if (!env.SLACK_SIGNING_SECRET) {
    const isLocalDev =
      !process.env.VERCEL_ENV &&
      (process.env.NODE_ENV === "development" ||
        process.env.NODE_ENV === "test");
    if (!isLocalDev) {
      console.error(
        "[slack webhook] SLACK_SIGNING_SECRET is not set, rejecting Slack webhook",
      );
      return false;
    }
    console.warn(
      "[slack webhook] SLACK_SIGNING_SECRET is not set, skipping verification (dev only)",
    );
    return true;
  }
  const timestamp = req.headers.get("x-slack-request-timestamp")!;
  const slackSig = req.headers.get("x-slack-signature")!;
  if (!timestamp || !slackSig) {
    return false;
  }
  const timestampNumber = Number(timestamp);
  if (!Number.isFinite(timestampNumber)) {
    return false;
  }
  // Replay protection (5 minutes)
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestampNumber) > 60 * 5) {
    return false;
  }
  const basestring = `v0:${timestamp}:${body}`;
  const hmac = crypto
    .createHmac("sha256", env.SLACK_SIGNING_SECRET)
    .update(basestring)
    .digest("hex");
  const mySig = `v0=${hmac}`;
  // timingSafeEqual requires equal lengths
  const a = Buffer.from(mySig);
  const b = Buffer.from(slackSig);
  if (a.length !== b.length) {
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parsePayload(rawBody: string): Record<string, unknown> | null {
  try {
    if (rawBody.startsWith("payload=")) {
      const form = new URLSearchParams(rawBody);
      const payload = form.get("payload");
      if (!payload) {
        return null;
      }
      const parsed = JSON.parse(payload);
      return isObject(parsed) ? parsed : null;
    }
    const parsed = JSON.parse(rawBody);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseRetryActionValue(value: unknown) {
  if (typeof value !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    if (!isObject(parsed)) {
      return null;
    }
    const text = parsed.text;
    const channel = parsed.channel;
    const user = parsed.user;
    const ts = parsed.ts;
    const team = parsed.team;
    const threadTs = parsed.thread_ts;
    const messageTs =
      typeof ts === "string"
        ? ts
        : typeof threadTs === "string"
          ? threadTs
          : null;
    if (
      typeof text !== "string" ||
      typeof channel !== "string" ||
      typeof user !== "string" ||
      messageTs === null ||
      typeof team !== "string"
    ) {
      return null;
    }
    return {
      text,
      channel,
      user,
      ts: messageTs,
      team,
      thread_ts: typeof threadTs === "string" ? threadTs : undefined,
    };
  } catch {
    return null;
  }
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();

  if (!verifySlackSignature(req, rawBody)) {
    console.error("[slack webhook] Invalid signature");
    return NextResponse.json(
      { success: false, error: "Invalid signature" },
      { status: 401 },
    );
  }

  const payload = parsePayload(rawBody);
  if (!payload) {
    console.error("[slack webhook] Invalid payload");
    return NextResponse.json(
      { success: false, error: "Invalid payload" },
      { status: 400 },
    );
  }

  const event = isObject(payload.event) ? payload.event : null;

  console.log(
    "[slack webhook] Received event type:",
    payload.type,
    event?.type,
  );

  // Handle Slack URL verification challenge
  if (payload.type === "url_verification") {
    const challenge =
      typeof payload.challenge === "string" ? payload.challenge : "";
    console.log("[slack webhook] Responding to URL verification challenge");
    return new Response(challenge, { status: 200 });
  }

  // Handle interactive messages (button clicks)
  if (payload.type === "block_actions") {
    const actions = Array.isArray(payload.actions) ? payload.actions : [];
    const action = isObject(actions[0]) ? actions[0] : null;
    console.log("[slack webhook] Received block action:", action?.action_id);
    if (action?.action_id === "retry_task_creation") {
      const retryData = parseRetryActionValue(action.value);
      if (!retryData) {
        console.error("[slack webhook] Invalid retry action payload");
        return NextResponse.json(
          { success: false, error: "Invalid retry action payload" },
          { status: 400 },
        );
      }
      const actorUserId = isObject(payload.user) ? payload.user.id : null;
      const actorTeamId = isObject(payload.team) ? payload.team.id : null;
      if (actorUserId !== retryData.user || actorTeamId !== retryData.team) {
        console.warn("[slack webhook] Ignoring retry from mismatched actor", {
          actorUserId,
          actorTeamId,
          retryUser: retryData.user,
          retryTeam: retryData.team,
        });
        return new Response("ok", { status: 200 });
      }
      console.log("[slack webhook] Retrying task creation", {
        team: retryData.team,
        channel: retryData.channel,
        user: retryData.user,
        ts: retryData.ts,
        threadTs: retryData.thread_ts,
      });

      // Trigger the app mention handler again with the stored event data
      waitUntil(
        handleAppMentionEvent({
          type: "app_mention",
          user: retryData.user,
          text: retryData.text,
          ts: retryData.ts,
          channel: retryData.channel,
          thread_ts: retryData.thread_ts,
          team: retryData.team,
        }).catch((error) => {
          console.error("[slack webhook] Error retrying task creation:", error);
        }),
      );
    }
  }

  // Handle app mentions
  if (event?.type === "app_mention") {
    const teamId =
      typeof event.team === "string"
        ? event.team
        : typeof payload.team_id === "string"
          ? payload.team_id
          : null;
    if (
      typeof event.user !== "string" ||
      typeof event.ts !== "string" ||
      typeof event.channel !== "string" ||
      teamId === null
    ) {
      console.error("[slack webhook] Invalid app mention payload");
      return NextResponse.json(
        { success: false, error: "Invalid app mention payload" },
        { status: 400 },
      );
    }
    console.log(
      "[slack webhook] Processing app mention from user:",
      event.user,
    );
    // Process asynchronously to return 200 immediately to Slack
    waitUntil(
      handleAppMentionEvent({
        type: "app_mention",
        user: event.user,
        text: typeof event.text === "string" ? event.text : "",
        ts: event.ts,
        channel: event.channel,
        thread_ts:
          typeof event.thread_ts === "string" ? event.thread_ts : undefined,
        team: teamId,
        enterprise:
          typeof event.enterprise === "string" ? event.enterprise : undefined,
        channel_team:
          typeof event.channel_team === "string"
            ? event.channel_team
            : undefined,
        source_team:
          typeof event.source_team === "string" ? event.source_team : undefined,
        files: Array.isArray(event.files) ? event.files : undefined,
        slackEventId:
          typeof payload.event_id === "string" ? payload.event_id : undefined,
        edited: isObject(event.edited)
          ? {
              user: String(event.edited.user ?? ""),
              ts: String(event.edited.ts ?? ""),
            }
          : undefined,
      }).catch((error) => {
        console.error("[slack webhook] Error processing app mention:", error);
      }),
    );
  }

  if (event?.type === "message") {
    const teamId =
      typeof event.team === "string"
        ? event.team
        : typeof payload.team_id === "string"
          ? payload.team_id
          : null;
    waitUntil(
      import("@/server-lib/slack/slack-router")
        .then(({ handleSlackMessageEvent }) =>
          handleSlackMessageEvent({
            event: {
              type: "message",
              user: typeof event.user === "string" ? event.user : undefined,
              text: typeof event.text === "string" ? event.text : "",
              ts: typeof event.ts === "string" ? event.ts : undefined,
              channel:
                typeof event.channel === "string" ? event.channel : undefined,
              thread_ts:
                typeof event.thread_ts === "string"
                  ? event.thread_ts
                  : undefined,
              team: teamId ?? undefined,
              bot_id:
                typeof event.bot_id === "string" ? event.bot_id : undefined,
              subtype:
                typeof event.subtype === "string" ? event.subtype : undefined,
              hidden: event.hidden === true,
              files: Array.isArray(event.files) ? event.files : undefined,
              edited: event.edited,
            },
            slackEventId:
              typeof payload.event_id === "string"
                ? payload.event_id
                : undefined,
          }),
        )
        .catch((error) => {
          console.error(
            "[slack webhook] Error processing message event:",
            error,
          );
        }),
    );
  }

  return new Response("ok", { status: 200 });
}
