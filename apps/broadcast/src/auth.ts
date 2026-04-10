import {
  getInternalSharedSecret,
  getPublicAppUrl,
} from "@leo/env/apps-broadcast";
import type * as Party from "partykit/server";

export async function validateRequest(
  request: Party.Request,
  channel: string | null,
  env: Record<string, unknown>,
) {
  if (!channel) {
    const sharedSecret =
      request.headers.get("X-Leo-Secret") ??
      request.headers.get("X-Terragon-Secret");
    if (sharedSecret && sharedSecret === getInternalSharedSecret(env)) {
      return;
    }
    if (sharedSecret) {
      console.error("Invalid shared secret");
      throw new Error("Invalid shared secret");
    }
    throw new Error("Must specify channel");
  }

  const url = new URL(request.url);

  const apiKeyFromQuery = url.searchParams.get("apiKey");
  if (apiKeyFromQuery) {
    const response = await fetch(
      `${getPublicAppUrl(env)}/api/internal/broadcast?channel=${channel}`,
      { headers: { "X-Daemon-Token": apiKeyFromQuery } },
    );
    if (!response.ok) {
      console.error("Invalid apiKey in query param");
      throw new Error("Invalid API key");
    }
    return;
  }

  const token =
    url.searchParams.get("token") ?? request.headers.get("Authorization") ?? "";
  if (token) {
    const response = await fetch(
      `${getPublicAppUrl(env)}/api/internal/broadcast?channel=${channel}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!response.ok) {
      console.error("Invalid token");
      throw new Error("Invalid token");
    }
    return;
  }

  throw new Error("Invalid request");
}
