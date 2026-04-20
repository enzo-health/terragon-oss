import {
  type BroadcastSandboxMessage,
  getBroadcastChannelStr,
} from "@terragon/types/broadcast";
import { SandboxProvider } from "@terragon/types/sandbox";
import { useAtomValue } from "jotai";
import { userAtom } from "@/atoms/user";
import { useRealtimeBase } from "./useRealtime";

/**
 * Subscribes to PartyKit realtime broadcasts scoped to a single sandbox
 * (terminal output, lifecycle updates, etc.).
 *
 * Lives in its own module so that Phase 6 can delete the broader
 * thread/user realtime machinery without disturbing terminal-embedded
 * consumers.
 */
export function useRealtimeSandbox({
  threadId,
  sandboxId,
  sandboxProvider,
  matches,
  onMessage,
}: {
  threadId: string;
  sandboxId: string;
  sandboxProvider: SandboxProvider;
  matches: (message: BroadcastSandboxMessage) => boolean;
  onMessage: (message: BroadcastSandboxMessage) => void;
}) {
  const user = useAtomValue(userAtom);
  return useRealtimeBase({
    party: "sandbox",
    channel: getBroadcastChannelStr({
      type: "sandbox",
      userId: user?.id ?? "",
      threadId,
      sandboxId,
      sandboxProvider,
    }),
    debounceMs: 0,
    matches: (message) => message.type === "sandbox" && matches(message),
    onMessage: (message) => {
      if (message.type === "sandbox") {
        onMessage(message);
      }
    },
    disconnectOnDismount: true,
    trackReadyState: true,
  });
}
