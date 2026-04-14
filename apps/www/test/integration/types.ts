import type { DaemonEventAPIBody } from "@terragon/daemon/shared";

/**
 * A single captured daemon-event POST, as written by the recorder and stored
 * in JSONL recording files.
 */
export type RecordedDaemonEvent = {
  /** Wall-clock millisecond offset from the start of the recording. */
  wallClockMs: number;
  /** The parsed request body that was POSTed to /api/daemon-event. */
  body: DaemonEventAPIBody;
  /** HTTP headers that were included in the original request. */
  headers: Record<string, string>;
};
