"use client";

import type { HttpAgent } from "@ag-ui/client";
import React, { createContext, useContext, type ReactNode } from "react";

/**
 * Shares the current thread's AG-UI `HttpAgent` with descendants that need
 * to subscribe to its event stream (e.g. meta chips, boot checklist).
 *
 * The agent is constructed once in `ChatUI` via `useAgUiTransport`. Both
 * `ChatHeader` (where the chip cluster lives) and `TerragonThread` (where
 * the boot checklist lives, inside message rendering) sit under this
 * provider so they can call `useAgUiAgent()` without threading the agent
 * as props through intermediate components.
 *
 * Returns `null` when no provider is mounted or the agent is not yet
 * available. Consumers should tolerate null (no-op subscription) so that
 * components keep rendering during initial load when the transport has
 * not been constructed yet.
 */
const AgUiAgentContext = createContext<HttpAgent | null>(null);

export function AgUiAgentProvider({
  agent,
  children,
}: {
  agent: HttpAgent | null;
  children: ReactNode;
}) {
  return (
    <AgUiAgentContext.Provider value={agent}>
      {children}
    </AgUiAgentContext.Provider>
  );
}

export function useAgUiAgent(): HttpAgent | null {
  return useContext(AgUiAgentContext);
}
