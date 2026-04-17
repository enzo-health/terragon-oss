// Thread status change hooks.
//
// This module previously posted a Terragon-branded GitHub check run to the PR
// on thread stop/error so the PR surface reflected the task state. That check
// run was write-only (nothing in Terragon read it back), and it blocked PRs
// from reaching merge-green whenever a thread errored without reaching the
// happy-path terminal update. It has been removed; task state is surfaced via
// the Terragon UI, PR comments, and the per-loop canonical check summary.

export async function onThreadChatStopped(_params: {
  userId: string;
  threadId: string;
  threadChatId: string;
}) {
  // no-op
}

export async function onThreadChatError(_params: {
  userId: string;
  threadId: string;
  threadChatId: string;
}) {
  // no-op
}
