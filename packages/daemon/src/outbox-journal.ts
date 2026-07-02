/**
 * Append-only disk journal for the daemon's outbound event buffer.
 *
 * The daemon's message/delta/meta buffers are memory-only: a process death
 * (OOM, kill, sandbox restart) between "event enqueued" and "server acked the
 * POST" permanently loses every un-acked event, and the only backstop is the
 * server's ~15-minute deadline sweep marking the run failed. This journal
 * closes that window.
 *
 * Lifecycle: append (just before the POST) -> POST -> drop-on-ack -> replay on
 * restart. The unit journaled is the fully-formed `DaemonEventAPIBody` *with its
 * minted v2 envelope identity* (runId/eventId/seq) plus the daemon token used to
 * send it. Journaling at the send boundary (not raw pre-identity buffer entries)
 * is deliberate: the server dedupes on `(runId, eventId)` and CAS-rejects
 * duplicate terminals, so replaying the *same* identity is idempotent, whereas
 * replaying under a fresh identity would insert duplicate rows. The daemon token
 * is also runId-bound server-side, so a verbatim re-POST is the only replay that
 * survives the claim check.
 *
 * Durability is best-effort: a torn last line (crash mid-write) is skipped, and
 * any journal I/O error is caught and logged so the live flush path degrades to
 * memory-only rather than breaking. A lost tail only shrinks the recovery
 * window; it never corrupts.
 */

import { promises as fsp } from "node:fs";
import * as path from "node:path";
import type { DaemonEventAPIBody } from "./shared";

export const DEFAULT_OUTBOX_JOURNAL_DIR = "/tmp/terragon-daemon-outbox";

/** Rewrite a file dropping acked entries once it grows past this many bytes. */
const DEFAULT_COMPACT_THRESHOLD_BYTES = 1_000_000;

const JOURNAL_RECORD_VERSION = 1 as const;

type JournalLogger = {
  info?: (message: string, data?: Record<string, unknown>) => void;
  warn?: (message: string, data?: Record<string, unknown>) => void;
  error?: (message: string, data?: Record<string, unknown>) => void;
};

export type OutboxJournalEventRecord = {
  v: typeof JOURNAL_RECORD_VERSION;
  t: "event";
  threadChatId: string;
  runId: string;
  eventId: string;
  seq: number;
  token: string;
  body: DaemonEventAPIBody;
  ts: number;
};

type OutboxJournalAckRecord = {
  v: typeof JOURNAL_RECORD_VERSION;
  t: "ack";
  threadChatId: string;
  runId: string;
  eventId: string;
  seq: number;
  ts: number;
};

type OutboxJournalRecord = OutboxJournalEventRecord | OutboxJournalAckRecord;

export type OutboxJournalOptions = {
  dir?: string;
  enabled?: boolean;
  logger?: JournalLogger;
  compactThresholdBytes?: number;
};

/** Filesystem-safe file name for a thread's journal. */
function journalFileName(threadChatId: string): string {
  const safe = threadChatId.replace(/[^A-Za-z0-9_-]/g, "_");
  return `outbox-${safe}.jsonl`;
}

/**
 * Parse a JSONL journal buffer into records, tolerating a torn/partial final
 * line and any interior line that fails to parse (skipped, not fatal).
 */
export function parseJournalBuffer(raw: string): OutboxJournalRecord[] {
  const records: OutboxJournalRecord[] = [];
  const lines = raw.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // Torn last line or otherwise corrupt entry: skip it.
      continue;
    }
    if (!parsed || typeof parsed !== "object") {
      continue;
    }
    const rec = parsed as Partial<OutboxJournalRecord>;
    if (
      (rec.t === "event" || rec.t === "ack") &&
      typeof rec.eventId === "string" &&
      typeof rec.runId === "string" &&
      typeof rec.threadChatId === "string"
    ) {
      records.push(rec as OutboxJournalRecord);
    }
  }
  return records;
}

/**
 * Given a file's records, return the unacked event records deduplicated by
 * eventId (identity is reused across retries, so the same event can be
 * journaled more than once) in append order.
 */
export function selectUnackedEvents(
  records: OutboxJournalRecord[],
): OutboxJournalEventRecord[] {
  const ackedEventIds = new Set<string>();
  for (const rec of records) {
    if (rec.t === "ack") {
      ackedEventIds.add(rec.eventId);
    }
  }
  const byEventId = new Map<string, OutboxJournalEventRecord>();
  for (const rec of records) {
    if (rec.t !== "event") {
      continue;
    }
    if (ackedEventIds.has(rec.eventId)) {
      continue;
    }
    // Keep the latest journaled copy for a given identity; insertion order in a
    // Map is preserved, so re-setting an existing key does not reorder it.
    byEventId.set(rec.eventId, rec);
  }
  return [...byEventId.values()];
}

export class OutboxJournal {
  private readonly dir: string;
  private readonly enabled: boolean;
  private readonly logger: JournalLogger;
  private readonly compactThresholdBytes: number;

  /** Per-file serialized write chain: guarantees ordered, non-overlapping I/O. */
  private readonly writeChains = new Map<string, Promise<void>>();
  /** Approximate bytes appended since the last compaction, per file. */
  private readonly appendedBytes = new Map<string, number>();
  private ensuredDir = false;

  constructor(options: OutboxJournalOptions = {}) {
    this.dir = options.dir ?? DEFAULT_OUTBOX_JOURNAL_DIR;
    this.enabled = options.enabled ?? true;
    this.logger = options.logger ?? {};
    this.compactThresholdBytes =
      options.compactThresholdBytes ?? DEFAULT_COMPACT_THRESHOLD_BYTES;
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  private filePath(threadChatId: string): string {
    return path.join(this.dir, journalFileName(threadChatId));
  }

  private async ensureDir(): Promise<void> {
    if (this.ensuredDir) {
      return;
    }
    await fsp.mkdir(this.dir, { recursive: true });
    this.ensuredDir = true;
  }

  /**
   * Enqueue `work` onto the given file's serialized chain. Failures are caught
   * and logged; the chain never rejects, so one bad write cannot poison
   * subsequent writes or surface into the live flush path.
   */
  private enqueue(
    filePath: string,
    work: () => Promise<void>,
    context: string,
  ): Promise<void> {
    const previous = this.writeChains.get(filePath) ?? Promise.resolve();
    const next = previous.then(async () => {
      try {
        await work();
      } catch (error) {
        this.logger.error?.("Outbox journal write failed; degrading", {
          context,
          filePath,
          error: String(error),
        });
      }
    });
    this.writeChains.set(filePath, next);
    void next.finally(() => {
      if (this.writeChains.get(filePath) === next) {
        this.writeChains.delete(filePath);
      }
    });
    return next;
  }

  /** Append an event record just before its POST. Fire-and-forget. */
  recordEvent(entry: {
    threadChatId: string;
    runId: string;
    eventId: string;
    seq: number;
    token: string;
    body: DaemonEventAPIBody;
  }): void {
    if (!this.enabled) {
      return;
    }
    const record: OutboxJournalEventRecord = {
      v: JOURNAL_RECORD_VERSION,
      t: "event",
      threadChatId: entry.threadChatId,
      runId: entry.runId,
      eventId: entry.eventId,
      seq: entry.seq,
      token: entry.token,
      body: entry.body,
      ts: Date.now(),
    };
    this.appendRecord(record);
  }

  /** Append an ack marker after the server acked the POST. Fire-and-forget. */
  recordAck(entry: {
    threadChatId: string;
    runId: string;
    eventId: string;
    seq: number;
  }): void {
    if (!this.enabled) {
      return;
    }
    const record: OutboxJournalAckRecord = {
      v: JOURNAL_RECORD_VERSION,
      t: "ack",
      threadChatId: entry.threadChatId,
      runId: entry.runId,
      eventId: entry.eventId,
      seq: entry.seq,
      ts: Date.now(),
    };
    this.appendRecord(record);
  }

  private appendRecord(record: OutboxJournalRecord): void {
    const filePath = this.filePath(record.threadChatId);
    const line = `${JSON.stringify(record)}\n`;
    void this.enqueue(
      filePath,
      async () => {
        await this.ensureDir();
        await fsp.appendFile(filePath, line, "utf8");
        const total =
          (this.appendedBytes.get(filePath) ?? 0) + Buffer.byteLength(line);
        this.appendedBytes.set(filePath, total);
        if (record.t === "ack" && total >= this.compactThresholdBytes) {
          await this.compactFileInline(filePath, record.threadChatId);
        }
      },
      record.t,
    );
  }

  /**
   * Rewrite a single file dropping acked events and all ack markers. Runs inside
   * the file's write chain, so no concurrent append can interleave. If nothing
   * survives, the file is removed.
   */
  private async compactFileInline(
    filePath: string,
    threadChatId: string,
  ): Promise<void> {
    let raw: string;
    try {
      raw = await fsp.readFile(filePath, "utf8");
    } catch {
      this.appendedBytes.delete(filePath);
      return;
    }
    const unacked = selectUnackedEvents(parseJournalBuffer(raw));
    if (unacked.length === 0) {
      await fsp.rm(filePath, { force: true });
      this.appendedBytes.delete(filePath);
      return;
    }
    const rewritten = `${unacked.map((r) => JSON.stringify(r)).join("\n")}\n`;
    const tmpPath = `${filePath}.compact-${process.pid}-${Date.now()}`;
    await fsp.writeFile(tmpPath, rewritten, "utf8");
    await fsp.rename(tmpPath, filePath);
    this.appendedBytes.set(filePath, Buffer.byteLength(rewritten));
    this.logger.info?.("Compacted outbox journal", {
      threadChatId,
      keptEvents: unacked.length,
    });
  }

  /** Await all pending writes. Used by shutdown and by tests. */
  async flush(): Promise<void> {
    await Promise.allSettled([...this.writeChains.values()]);
  }

  /**
   * Read every journal file and return the unacked events across all threads.
   * Per-thread append order (== seq order) is preserved within each file; the
   * caller replays each thread's events in that order. A file that fails to read
   * or parse degrades to "no recoverable events" rather than throwing.
   */
  async loadUnacked(): Promise<OutboxJournalEventRecord[]> {
    if (!this.enabled) {
      return [];
    }
    let fileNames: string[];
    try {
      fileNames = await fsp.readdir(this.dir);
    } catch {
      // Directory does not exist yet: nothing to recover.
      return [];
    }
    const out: OutboxJournalEventRecord[] = [];
    for (const name of fileNames) {
      if (!name.startsWith("outbox-") || !name.endsWith(".jsonl")) {
        continue;
      }
      const filePath = path.join(this.dir, name);
      try {
        const raw = await fsp.readFile(filePath, "utf8");
        out.push(...selectUnackedEvents(parseJournalBuffer(raw)));
      } catch (error) {
        this.logger.warn?.("Failed to read outbox journal file; skipping", {
          filePath,
          error: String(error),
        });
      }
    }
    return out;
  }

  /** Await pending writes, then compact every file. Called on clean shutdown. */
  async shutdown(): Promise<void> {
    if (!this.enabled) {
      return;
    }
    await this.flush();
    let fileNames: string[];
    try {
      fileNames = await fsp.readdir(this.dir);
    } catch {
      return;
    }
    for (const name of fileNames) {
      if (!name.startsWith("outbox-") || !name.endsWith(".jsonl")) {
        continue;
      }
      const filePath = path.join(this.dir, name);
      const threadChatId = name.slice("outbox-".length, -".jsonl".length);
      await this.enqueue(
        filePath,
        () => this.compactFileInline(filePath, threadChatId),
        "shutdown-compact",
      );
    }
    await this.flush();
  }
}
