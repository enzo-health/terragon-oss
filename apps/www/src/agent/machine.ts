import { ThreadChatInsert, ThreadStatus } from "@leo/shared";
import { createMachine, transition } from "xstate";

export type ThreadEvent =
  | "system.boot"
  | "system.concurrency-limit"
  | "system.sandbox-creation-rate-limit"
  | "system.agent-rate-limit"
  | "system.draft"
  | "system.resume"
  | "system.message"
  | "system.checkpoint"
  | "system.slash-command-done"
  | "system.checkpoint-done"
  | "system.error"
  | "system.stop"
  | "user.stop"
  | "user.message"
  | "user.queue"
  | "user.schedule"
  | "user.cancel-schedule"
  | "user.retry-checkpoint"
  | "assistant.message"
  | "assistant.message_error"
  | "assistant.message_stop"
  | "assistant.message_done"
  | "assistant.message_done_skip_checkpoint";

export const machine = createMachine({
  /** @xstate-layout N4IgpgJg5mDOIC5QBcAWAnMBDCA6AjgK5jEQDEsAnrMmALa4BGA9s8gNoAMAuoqAA7NYAS2TDmAOz4gAHogBMARgCsuABzKAnAGZl2tWs6cALIvlqANCEqJlagOy4Tml-PvbtnTQDZvAXz8rNEwcAmJSCmpaBgBjSRjCdEwJGMoAWgAbYTpRLl4kEEERMUlpOQQlVQ0dPQMjU3MrGwRjeXlcD203b0VtYwdjewCgjGw8IhJISJp6XFgsCQgWGTSYkJKJNPQsWkzs3J5pItFxKQLyyvUtXX1DEzNLa1t5bQ6Pc2NveU1Few1hkDBMZhSbkQiwMDoObIZj8PJHIQnUrnBQqK41W71B5NBScdryYwuNR9TRKbz2QYAoGhCYRKgzBiQ9DMdDwgrHDZlVFVa61O4NR7NeTKdoUon2dw6RQ6eRU0Y08KQNLILCwADWsFW8USyVS02iuEwsEIdDAbIEiM5KIQ2m8rzUmk4ykJfy0n2UOJt9kU6k6L2lX3MymUcpC40VEGVqo1WpSOrAKUoZHBkOhsPNhUtpy5CAc3lwX36am8xkJvkJnu07lwhKJmmL5k0elDwNpSpV6s1cTjSQTevpBqZLIzHOz1rzBYJBhLZZLmk9rVeLhcrUMKlMlMCgPl4dBaXmi2Wq3Wpy2OzAexyyH1syNJrNh3ZWeRoHKtvtjudmldmndC-s7TEl03ycO4IqKC2Cp7geSzMCsazYBsZ67FkV7JhCUI0Omj4WsUY6vogE6FtOpY+HO-7GDWdbKBSnCKHmxiQbupD7gssHwSekjIReqGiDejJJMOOGZnhL6yIR9j5sRxakeW85PAgIqUcuTZmE2ajGCKTFMKwYgSFAZCqiINALMguCmrA8wwCOz5nARuaSZORYzmRFYKfYXhOEBui-G4ii-NpLBsMI+noamWFwsJo5ieURFTjJs5uc0ri4F+y5tMKyigYFukhQZRnCCZEhmRZVlgAA+kOrJRbZOZxc5snkQpZjeJwVH1n5RjaD82g5cFoUDrMVU2aJdniQ5UnxS5cmejRqhZUYnDeBoKh4kMW7UngADuLJqnlYWYTCkX5LhSJjeULVtcuBg0V8oGSZ6Dg+vY6V0baZKyhtO64Dt6B7aFBVFSVcBlZVgnVSdIlnTml24NdGiSfI93eJ6-ndbgYoUmuxhOt4mjab9-35ZZhUqsV5kg1gMDlRAkgPpD0XnYgsPw7dSMSijzX6D6BL1pwuh496rQE7t+2A2TwOWVTFURSN0PWizRII3dHOenj+bCl1nzfB4Kgi39+2DQJzIQwio0w-IrVw0rbPI56FL5mK9b2Mo5Lfn82kRfwYsk0DFNS9Tw01ebCslvitaKHjGlZV0qN0Wo1sdUGXTdSGX1hmm-DewDvsS-7oOy8H8v2ZHrS4LzPxR5p-PyI95LtT4ONVp4Xie0d2cGUbuBBwztWh2XFeR-W1exwpPyOCpQ8u7+60jBnXuG1EsyF73Icl2H5cR1XMe12Py3tcWLiKJpOi9enwKE3laS0xIYD8bgMSoGAMRqoIIUcEXVr2UjOPl5bt00TaGoSOqNuabz5gLb8x9PpzwvqLfSaQqr30fs-V+zB35yy-uNH+bU2jeAAQBcwIDmq9E0BjF0-Q6I41dvjc+oQUEvzfsVReDIH5P0Yeg4q186aYPwtg7qZD+ifCWlWPEnBBTM2Pm1Ow2hej-zsD4bSDC0HvxYYOcGvCYoKAETWDSrU7QeSRhIhA-kfheU8BoN0zolBKOYHQfgGQwC0AOvnaWmimYVEobgfyYEfDEi+BpR6Ppaz1l6MtLQKh-AAgkMwCAcBpCbTNsXcaaRObNFSU4RaWTsnZTocxSASSsHlFaJ6Hw3jbgc0UEYJss9twZzbJGDsMZuwJF7ImQpfDyiuwTtKH4XgNJtFLIoSshgayRxLMWYsXVtINNYoeOCx5EKnm2ChfYyAOlaMUvoVK+h6zfkdJM4ZCl+jBPGU6J6a4TB9T0lADZHiPKUVIXiMw3wXpNlmg4VKC1Sz3Fai8fWRM7kw38gnYi7hQLmEMNoe2nkZEeGUL5b0AU8mZw7kChWWVHlUN8EYNoFjHovVSrWHWTZCQEgBVfG+YB0UlwMJRTWRhAyDGhVzYB5D6zOgcGoJQ9YKUIKqjS8a9ENLlwWktQZ7hUZSPAW84Crs3BKPYSo5h+lBUXAJD6aoWg7TgWLGkyRgx2ouwAu4P0tj7GONoGqhQDyayaX0RoHoGhZp-FSotOwkdFoaQCAEIAA */
  id: "thread",
  initial: "queued",
  types: {
    events: {} as {
      type: ThreadEvent;
    },
  },
  states: {
    draft: {
      on: {
        "user.queue": "queued",
        "user.schedule": "scheduled",
      },
    },
    scheduled: {
      on: {
        "user.message": "scheduled",
        "system.resume": "queued",
        "user.cancel-schedule": "complete",
      },
    },
    queued: {
      on: {
        "system.draft": "draft",
        "system.boot": "booting",
        "system.concurrency-limit": "queued-tasks-concurrency",
        "system.sandbox-creation-rate-limit":
          "queued-sandbox-creation-rate-limit",
        "system.slash-command-done": "complete",
        "user.stop": "complete",
        "system.error": "complete",
      },
    },
    "queued-tasks-concurrency": {
      on: {
        "system.resume": "queued",
        "user.stop": "complete",
        "system.error": "complete",
      },
    },
    "queued-sandbox-creation-rate-limit": {
      on: {
        "system.resume": "queued",
        "user.stop": "complete",
        "system.error": "complete",
      },
    },
    "queued-agent-rate-limit": {
      on: {
        "system.resume": "queued",
        "user.stop": "complete",
        "system.error": "complete",
        // system messages and checkpoint should be allowed in this state. Just re-enter the state.
        "system.message": "queued-agent-rate-limit",
        "system.checkpoint": "queued-agent-rate-limit",
        "system.checkpoint-done": "queued-agent-rate-limit",
      },
    },
    booting: {
      on: {
        "user.stop": "stopping",
        "assistant.message": "working",
        "assistant.message_error": "working-error",
        "assistant.message_done": "working-done",
        "system.slash-command-done": "complete",
        "assistant.message_done_skip_checkpoint": "complete",
        "system.agent-rate-limit": "queued-agent-rate-limit",
        "system.concurrency-limit": "queued-tasks-concurrency",
        "system.error": "complete",
      },
    },
    working: {
      on: {
        "user.stop": "stopping",
        "assistant.message_error": "working-error",
        "assistant.message_done": "working-done",
        "system.slash-command-done": "complete",
        "assistant.message_done_skip_checkpoint": "complete",
        "assistant.message_stop": "complete",
        "system.agent-rate-limit": "queued-agent-rate-limit",
        "system.error": "complete",
      },
    },
    stopping: {
      on: {
        "user.message": "working",
        "assistant.message_error": "working-error",
        "assistant.message_stop": "complete",
        "system.error": "complete",
        "system.stop": "complete",
      },
    },
    "working-done": {
      on: {
        "user.message": "working",
        "system.checkpoint": "checkpointing",
      },
    },
    "working-error": {
      on: {
        "user.message": "working",
        "system.checkpoint": "checkpointing",
      },
    },
    checkpointing: {
      on: {
        "system.message": "working",
        "system.checkpoint-done": "complete",
        "system.error": "complete",
      },
    },
    complete: {
      on: {
        "user.message": "queued",
        "system.message": "queued",
        "user.retry-checkpoint": "working-done",
      },
    },
  },
  on: {
    "user.stop": ".complete",
  },
});

export function handleTransition(
  status: ThreadStatus,
  eventType: ThreadEvent,
): ThreadChatInsert["status"] | null {
  const restoredState = machine.resolveState({
    value: status,
  });
  if (!restoredState.can({ type: eventType })) {
    console.log(`[${eventType}] NOOP ${status}`);
    return null;
  }
  const [nextState] = transition(machine, restoredState, {
    type: eventType,
  });
  const nextStatus = nextState.value;
  console.log(`[${eventType}] ${status} → ${nextStatus}`);
  return nextStatus as ThreadChatInsert["status"];
}
