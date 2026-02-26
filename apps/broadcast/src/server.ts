import type * as Party from "partykit/server";
import { validateRequest } from "./auth";
import { parseBroadcastChannel } from "@terragon/types/broadcast";

export default class BroadcastServer implements Party.Server {
  options: Party.ServerOptions = {
    // We're using partykit as a stateless broadcast server so hibernate
    // is what we want.
    hibernate: true,
  };

  constructor(readonly room: Party.Room) {}

  static async onBeforeConnect(request: Party.Request, lobby: Party.Lobby) {
    try {
      await validateRequest(
        request,
        lobby.id,
        lobby.env as Record<string, unknown>,
      );
      return request;
    } catch (e) {
      console.error(e);
      return new Response("Unauthorized", {
        status: 401,
      });
    }
  }

  static async onBeforeRequest(request: Party.Request, lobby: Party.Lobby) {
    try {
      await validateRequest(
        request,
        null,
        lobby.env as Record<string, unknown>,
      );
      return request;
    } catch (e) {
      console.error(e);
      return new Response("Unauthorized", {
        status: 401,
      });
    }
  }

  async onRequest(req: Party.Request) {
    if (req.method === "POST") {
      // Make sure we consume the body otherwise cloudflare
      // will throw an unhandled promise rejection.
      const message = await req.json();

      const parsedChannel = parseBroadcastChannel(this.room.id);
      if (parsedChannel?.type === "preview") {
        const previewMessage =
          typeof message === "object" && message !== null
            ? (message as Record<string, unknown>)
            : null;
        if (
          !previewMessage ||
          previewMessage.type !== "preview" ||
          previewMessage.previewSessionId !== parsedChannel.previewSessionId ||
          previewMessage.threadId !== parsedChannel.threadId ||
          previewMessage.threadChatId !== parsedChannel.threadChatId ||
          previewMessage.runId !== parsedChannel.runId ||
          previewMessage.userId !== parsedChannel.userId ||
          previewMessage.schemaVersion !== parsedChannel.schemaVersion
        ) {
          return new Response("Unauthorized", { status: 401 });
        }
      }

      this.room.broadcast(JSON.stringify(message));
      return new Response("OK");
    }
    return new Response("Method not allowed", { status: 405 });
  }
}

BroadcastServer satisfies Party.Worker;
