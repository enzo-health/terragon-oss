import type { ThreadErrorType } from "@terragon/shared";

/**
 * Classifies AG-UI runtime errors that are benign client-side lifecycle races,
 * not real failures the user needs to see.
 *
 * `@ag-ui/client`'s `verifyEvents` throws when a second `RUN_STARTED` reaches
 * the client while a run is still active (no intervening `RUN_FINISHED`). This
 * happens when a run stays active — e.g. a long-running command holds the run
 * open — and the runtime attempts another run, or a reconnect re-frames the
 * stream. The previous run is still streaming normally; nothing failed. Raising
 * a scary "An error occurred" in chat for this race is the user-visible bug.
 *
 * We match the exact `verifyEvents` lifecycle messages and suppress them. Real
 * errors (network, auth, tool failures, malformed streams) do not match and
 * still surface.
 */

const TRANSIENT_RUN_LIFECYCLE_PATTERNS: readonly RegExp[] = [
  // Second RUN_STARTED while the prior run is still active.
  /Cannot send 'RUN_STARTED' while a run is still active/i,
  // An event arrived after the run already finished — benign tail race on
  // reconnect / overlapping replay.
  /The run has already finished with 'RUN_FINISHED'/i,
];

export function isTransientRunLifecycleError(
  error: Pick<Error, "message"> | string | null | undefined,
): boolean {
  if (error === null || error === undefined) {
    return false;
  }
  const message = typeof error === "string" ? error : error.message;
  if (!message) {
    return false;
  }
  return TRANSIENT_RUN_LIFECYCLE_PATTERNS.some((pattern) =>
    pattern.test(message),
  );
}

// Local membership guard mirroring the ThreadErrorType union
// (packages/shared/src/db/types.ts, 18 members). A `code` field surviving on a
// runtime error is only treated as typed when it is a real ThreadErrorType;
// anything else (a RuntimeFailureCategory/DaemonTerminalErrorCategory string, a
// free-form message) degrades to `transport`.
const KNOWN_THREAD_ERROR_TYPES: ReadonlySet<ThreadErrorType> = new Set([
  "request-timeout",
  "no-user-message",
  "unknown-error",
  "sandbox-not-found",
  "sandbox-creation-failed",
  "sandbox-resume-failed",
  "missing-gemini-credentials",
  "missing-amp-credentials",
  "chatgpt-sub-required",
  "invalid-codex-credentials",
  "invalid-claude-credentials",
  "agent-not-responding",
  "agent-generic-error",
  "git-checkpoint-diff-failed",
  "git-checkpoint-push-failed",
  "setup-script-failed",
  "prompt-too-long",
  "queue-limit-exceeded",
]);

function asThreadErrorType(value: string | null): ThreadErrorType | null {
  return value !== null &&
    KNOWN_THREAD_ERROR_TYPES.has(value as ThreadErrorType)
    ? (value as ThreadErrorType)
    : null;
}

export type RuntimeErrorPayload =
  | { kind: "transient-lifecycle" }
  | { kind: "lock-held"; clientSubmissionId: string | null }
  | {
      kind: "run-failure";
      code: ThreadErrorType;
      clientSubmissionId: string | null;
      info: string;
    }
  | { kind: "transport"; clientSubmissionId: string | null; info: string };

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Split a non-transient runtime error into a typed payload. The runtime types
 * `onError` as `(error: Error) => void`, but extra fields ride along on the raw
 * error object when present (`code` from `@ag-ui/core` RunErrorEvent, and a
 * `clientSubmissionId` echoed by the pinned react-ag-ui patch from the run
 * config). Both are read defensively, so an unpatched runtime simply yields
 * `clientSubmissionId: null` / `transport` — today's behavior.
 */
export function extractRuntimeErrorPayload(error: Error): RuntimeErrorPayload {
  if (isTransientRunLifecycleError(error)) {
    return { kind: "transient-lifecycle" };
  }
  const bag = error as Error & { code?: unknown; clientSubmissionId?: unknown };
  const clientSubmissionId = readNonEmptyString(bag.clientSubmissionId);
  const info = error.message;
  if (/Run already in progress/i.test(info)) {
    return { kind: "lock-held", clientSubmissionId };
  }
  const code = asThreadErrorType(readNonEmptyString(bag.code));
  if (code !== null) {
    return { kind: "run-failure", code, clientSubmissionId, info };
  }
  return { kind: "transport", clientSubmissionId, info };
}
