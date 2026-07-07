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

function RealtimeHost({
  channel,
  onClose,
  onMessage,
  debounceMs = 0,
}: {
  channel: string;
  onClose?: () => void;
  onMessage?: (message: unknown) => void;
  debounceMs?: number;
}): null {
  useRealtimeBase({
    party: "main",
    channel,
    matches: () => true,
    onMessage: onMessage ?? (() => {}),
    onClose,
    debounceMs,
    disconnectOnDismount: true,
  });
  return null;
}

// Drive the socket's real "close" listeners — the ones useRealtimeBase actually
// registers — instead of asserting on a replaced hook, so the close → onClose wiring
// and its cleanup are exercised end to end.
function fireClose(socket: (typeof partySocketInstances)[number]): void {
  act(() => {
    socket.listeners.get("close")?.forEach((listener) => listener());
  });
}

function fireMessage(
  socket: (typeof partySocketInstances)[number],
  payload: unknown,
): void {
  act(() => {
    socket.listeners
      .get("message")
      ?.forEach((listener) => listener({ data: JSON.stringify(payload) }));
  });
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

  it("invokes onClose when the realtime socket emits close", () => {
    const onClose = vi.fn();
    render(createElement(RealtimeHost, { channel: "user:real", onClose }));
    const socket = partySocketInstances[0]!;

    fireClose(socket);

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("detaches the close listener when the host unmounts", () => {
    const onClose = vi.fn();
    render(createElement(RealtimeHost, { channel: "user:real", onClose }));
    const socket = partySocketInstances[0]!;

    fireClose(socket);
    expect(onClose).toHaveBeenCalledTimes(1);

    // Unmount the host (replace the tree) so its effect cleanup runs; a later close
    // must not re-fire onClose, proving removeEventListener detached the handler.
    render(createElement("div"));
    fireClose(socket);

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("useRealtimeBase debounced dispatch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("delivers the first message immediately on the leading edge", () => {
    const onMessage = vi.fn();
    render(
      createElement(RealtimeHost, {
        channel: "user:real",
        onMessage,
        debounceMs: 1000,
      }),
    );
    const socket = partySocketInstances[0]!;

    fireMessage(socket, { type: "user", data: { n: 1 } });

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenLastCalledWith({
      type: "user",
      data: { n: 1 },
    });
  });

  it("coalesces a burst into leading + a single trailing delivery", () => {
    const onMessage = vi.fn();
    render(
      createElement(RealtimeHost, {
        channel: "user:real",
        onMessage,
        debounceMs: 1000,
      }),
    );
    const socket = partySocketInstances[0]!;

    fireMessage(socket, { type: "user", data: { n: 1 } });
    fireMessage(socket, { type: "user", data: { n: 2 } });
    fireMessage(socket, { type: "user", data: { n: 3 } });

    expect(onMessage).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(onMessage).toHaveBeenLastCalledWith({
      type: "user",
      data: { n: 3 },
    });
  });

  it("does not double-fire a singleton message on the trailing edge", () => {
    const onMessage = vi.fn();
    render(
      createElement(RealtimeHost, {
        channel: "user:real",
        onMessage,
        debounceMs: 1000,
      }),
    );
    const socket = partySocketInstances[0]!;

    fireMessage(socket, { type: "user", data: { n: 1 } });
    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
  });
});
