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
