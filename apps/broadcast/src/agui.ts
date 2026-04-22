import type * as Party from "partykit/server";
import { validateRequest } from "./auth";

/**
 * AG-UI event relay party. Room ID = threadChatId.
 *
 * Stateless broadcast: the server-side publisher POSTs serialized BaseEvent
 * JSON; this party relays it to all WebSocket clients in the room. No DB
 * access, no event parsing, no state.
 */
export default class AgUiParty implements Party.Server {
  options: Party.ServerOptions = {
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
      return new Response("Unauthorized", { status: 401 });
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
      return new Response("Unauthorized", { status: 401 });
    }
  }

  async onRequest(req: Party.Request) {
    if (req.method === "POST") {
      const body = await req.json();
      const events = Array.isArray(body) ? body : [body];
      for (const event of events) {
        this.room.broadcast(JSON.stringify(event));
      }
      return new Response("OK");
    }
    return new Response("Method not allowed", { status: 405 });
  }
}

AgUiParty satisfies Party.Worker;
