import {
  BroadcastChannelUser,
  BroadcastUserMessage,
  getBroadcastChannelStr,
} from "@terragon/types/broadcast";
import { env } from "@terragon/env/pkg-shared";
import { publicBroadcastUrl } from "@terragon/env/next-public";

export async function publishBroadcastUserMessage(
  message: BroadcastUserMessage,
) {
  // Skip publishing broadcast messages in tests
  if (process.env.NODE_ENV === "test") {
    return;
  }
  const partySocketUrl = publicBroadcastUrl();
  if (!partySocketUrl) {
    console.warn("Party socket URL not set");
    return;
  }
  const channel: BroadcastChannelUser = {
    type: "user",
    id: message.id,
  };
  try {
    await fetch(
      `${partySocketUrl}/parties/main/${getBroadcastChannelStr(channel)}`,
      {
        method: "POST",
        body: JSON.stringify(message),
        headers: {
          "X-Terragon-Secret": env.INTERNAL_SHARED_SECRET!,
        },
      },
    );
  } catch (error) {
    console.warn("Broadcast publish failed", {
      channel,
      error,
    });
  }
}
