/**
 * Database queries for capturing a thread trace into an EvalFixture.
 *
 * Uses the drizzle relational query API to avoid cross-package type issues.
 */

import type { DB } from "../db";

export async function fetchThread(db: DB, threadId: string) {
  const row = await db.query.thread.findFirst({
    where: (t, { eq }) => eq(t.id, threadId),
  });
  if (!row) throw new Error(`Thread not found: ${threadId}`);
  return row;
}

export async function fetchThreadChat(db: DB, threadId: string) {
  const row = await db.query.threadChat.findFirst({
    where: (tc, { eq }) => eq(tc.threadId, threadId),
  });
  if (!row) throw new Error(`ThreadChat not found for thread: ${threadId}`);
  return row;
}

export async function fetchLoop(db: DB, threadId: string) {
  const row = await db.query.sdlcLoop.findFirst({
    where: (l, { eq }) => eq(l.threadId, threadId),
  });
  if (!row) throw new Error(`SdlcLoop not found for thread: ${threadId}`);
  return row;
}

export async function fetchArtifacts(db: DB, loopId: string) {
  return db.query.sdlcPhaseArtifact.findMany({
    where: (a, { eq }) => eq(a.loopId, loopId),
  });
}

export async function fetchPlanTasks(db: DB, loopId: string) {
  return db.query.sdlcPlanTask.findMany({
    where: (t, { eq }) => eq(t.loopId, loopId),
  });
}

export async function fetchSignals(db: DB, loopId: string) {
  return db.query.sdlcLoopSignalInbox.findMany({
    where: (s, { eq }) => eq(s.loopId, loopId),
    orderBy: (s, { asc }) => asc(s.receivedAt),
  });
}

export async function fetchDeepReviewRuns(db: DB, loopId: string) {
  return db.query.sdlcDeepReviewRun.findMany({
    where: (r, { eq }) => eq(r.loopId, loopId),
  });
}

export async function fetchDeepReviewFindings(db: DB, loopId: string) {
  return db.query.sdlcDeepReviewFinding.findMany({
    where: (f, { eq }) => eq(f.loopId, loopId),
  });
}

export async function fetchCarmackReviewRuns(db: DB, loopId: string) {
  return db.query.sdlcCarmackReviewRun.findMany({
    where: (r, { eq }) => eq(r.loopId, loopId),
  });
}

export async function fetchCarmackReviewFindings(db: DB, loopId: string) {
  return db.query.sdlcCarmackReviewFinding.findMany({
    where: (f, { eq }) => eq(f.loopId, loopId),
  });
}

export async function fetchCiGateRuns(db: DB, loopId: string) {
  return db.query.sdlcCiGateRun.findMany({
    where: (r, { eq }) => eq(r.loopId, loopId),
    orderBy: (r, { asc }) => asc(r.createdAt),
  });
}

export async function fetchReviewThreadGateRuns(db: DB, loopId: string) {
  return db.query.sdlcReviewThreadGateRun.findMany({
    where: (r, { eq }) => eq(r.loopId, loopId),
    orderBy: (r, { asc }) => asc(r.createdAt),
  });
}

export async function fetchAgentRunContexts(db: DB, threadId: string) {
  return db.query.agentRunContext.findMany({
    where: (a, { eq }) => eq(a.threadId, threadId),
  });
}
