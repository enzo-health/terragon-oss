/* @vitest-environment jsdom */

import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@terragon/env/next-public", () => ({
  publicBroadcastHost: () => "broadcast.test",
}));

vi.mock("jotai", () => ({
  useAtomValue: () => "test-token",
}));

vi.mock("@/atoms/user", () => ({
  bearerTokenAtom: Symbol("bearerTokenAtom"),
  userAtom: Symbol("userAtom"),
}));

const { MockPartySocket, partySocketInstances } = vi.hoisted(() => {
  type Listener = (event?: unknown) => void;

  class MockPartySocket {
    readyState: number = WebSocket.OPEN;
    readonly host: string;
    readonly party: string;
    readonly room: string;
    readonly query: () => { token: string };
    readonly listeners = new Map<string, Set<Listener>>();
    readonly sentMessages: string[] = [];
    close = vi.fn(() => {
      this.readyState = WebSocket.CLOSED;
    });
    reconnect = vi.fn(() => {
      this.readyState = WebSocket.OPEN;
    });

    constructor(options: {
      host: string;
      party: string;
      room: string;
      query: () => { token: string };
    }) {
      this.host = options.host;
      this.party = options.party;
      this.room = options.room;
      this.query = options.query;
      partySocketInstances.push(this);
    }

    addEventListener(type: string, listener: Listener): void {
      const listeners = this.listeners.get(type) ?? new Set<Listener>();
      listeners.add(listener);
      this.listeners.set(type, listeners);
    }

    removeEventListener(type: string, listener: Listener): void {
      this.listeners.get(type)?.delete(listener);
    }

    send(message: string): void {
      this.sentMessages.push(message);
    }
  }

  const partySocketInstances: MockPartySocket[] = [];
  return { MockPartySocket, partySocketInstances };
});

vi.mock("partysocket", () => ({
  default: MockPartySocket,
}));

import { resetRealtimeStateForTests } from "./realtime-socket-state";
import { useRealtimeBase } from "./useRealtime";

let container: HTMLDivElement;
let root: Root;

function render(ui: ReactElement): void {
  act(() => {
    root.render(ui);
  });
}

function RealtimeHost({ channel }: { channel: string }): null {
  useRealtimeBase({
    party: "main",
    channel,
    matches: () => false,
    onMessage: () => {},
    debounceMs: 0,
    disconnectOnDismount: true,
  });
  return null;
}

beforeEach(() => {
  partySocketInstances.length = 0;
  resetRealtimeStateForTests();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetRealtimeStateForTests();
});

describe("useRealtimeBase", () => {
  it("switches sockets immediately when the realtime channel changes", () => {
    render(createElement(RealtimeHost, { channel: "user:unknown" }));
    expect(partySocketInstances.map((socket) => socket.room)).toEqual([
      "user:unknown",
    ]);

    render(createElement(RealtimeHost, { channel: "user:real" }));

    expect(partySocketInstances.map((socket) => socket.room)).toEqual([
      "user:unknown",
      "user:real",
    ]);
  });
});
