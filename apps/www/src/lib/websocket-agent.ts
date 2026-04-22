"use client";

import { EventType, type BaseEvent, type RunAgentInput } from "@ag-ui/core";
import { HttpAgent, type HttpAgentConfig } from "@ag-ui/client";
import { Observable } from "rxjs";
import PartySocket from "partysocket";

type ReplayResponse = {
  events: BaseEvent[];
  runId: string | null;
  isComplete: boolean;
};

export interface WebSocketAgentConfig extends HttpAgentConfig {
  threadChatId: string;
  partyHost: string;
  authToken: string;
}

/**
 * AG-UI agent backed by REST replay + PartyKit WebSocket live-tail.
 *
 * Extends HttpAgent so all consumers typed as `HttpAgent` accept this
 * transparently (instanceof checks, function signatures, etc.).
 */
export class WebSocketAgent extends HttpAgent {
  readonly threadChatId: string;
  readonly partyHost: string;
  private _authToken: string;

  constructor(config: WebSocketAgentConfig) {
    super(config);
    this.threadChatId = config.threadChatId;
    this.partyHost = config.partyHost;
    this._authToken = config.authToken;
  }

  set authToken(value: string) {
    this._authToken = value;
  }

  override run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>((subscriber) => {
      const abort = new AbortController();
      this.abortController = abort;

      const doRun = async () => {
        const runId = this.extractRunIdFromUrl();

        const replayParams = new URLSearchParams({
          threadChatId: this.threadChatId,
        });
        if (runId) replayParams.set("runId", runId);
        const replayUrl = `/api/ag-ui/${encodeURIComponent(this.threadId)}/replay?${replayParams}`;

        const res = await fetch(replayUrl, { signal: abort.signal });
        if (!res.ok) {
          throw new Error(`AG-UI replay failed: ${res.status}`);
        }
        const replay: ReplayResponse = await res.json();

        for (const event of replay.events) {
          if (abort.signal.aborted) return;
          subscriber.next(event);
        }

        if (replay.isComplete) {
          subscriber.complete();
          return;
        }

        this.connectLiveTail(subscriber, abort);
      };

      doRun().catch((err) => {
        if (!abort.signal.aborted) {
          subscriber.error(err);
        }
      });

      return () => abort.abort();
    });
  }

  private extractRunIdFromUrl(): string | null {
    const qIdx = this.url.indexOf("?");
    if (qIdx === -1) return null;
    return new URLSearchParams(this.url.slice(qIdx + 1)).get("runId");
  }

  private connectLiveTail(
    subscriber: { next: (value: BaseEvent) => void; complete: () => void },
    abort: AbortController,
  ): void {
    const socket = new PartySocket({
      host: this.partyHost,
      party: "agui",
      room: this.threadChatId,
      query: () => ({ token: this._authToken }),
    });

    abort.signal.addEventListener("abort", () => socket.close());

    socket.addEventListener("message", (msg) => {
      try {
        const event = JSON.parse(msg.data) as BaseEvent;
        subscriber.next(event);
        if (
          event.type === EventType.RUN_FINISHED ||
          event.type === EventType.RUN_ERROR
        ) {
          subscriber.complete();
          socket.close();
        }
      } catch {
        // Malformed frame — skip without erroring the observable
      }
    });
  }
}
