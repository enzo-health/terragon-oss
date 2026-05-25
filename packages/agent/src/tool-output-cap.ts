/**
 * Hard cap on the size of a tool result's content as it crosses the
 * canonical → AG-UI boundary (`mapToolCallResult`). This is what gets
 * persisted to `agent_event_log` and streamed to the chat UI.
 *
 * Motivating incident: an over-broad `rg` produced an 840 KB `TOOL_CALL_RESULT`
 * that flooded the thread and the model's context. We middle-truncate (keep the
 * command echo at the head and the result/errors at the tail) and drop the
 * middle, matching Codex's `truncate_middle_*` strategy and Claude Code's
 * `BASH_MAX_OUTPUT_LENGTH`. The marker tells the reader (and the model)
 * truncation happened so it can narrow with grep/head instead of assuming
 * completeness.
 *
 * Character-based (JS string length), to match Claude Code's documented
 * "characters" semantics. This caps the persisted/displayed payload only;
 * provider-side model-context management (codex compaction, etc.) is separate.
 */

export const MAX_TOOL_RESULT_CHARS = 30_000;

export function capToolResultContent(
  content: string,
  maxChars: number = MAX_TOOL_RESULT_CHARS,
): string {
  if (content.length <= maxChars) {
    return content;
  }
  const removed = content.length - maxChars;
  const marker = `\n\n…${removed.toLocaleString()} characters truncated…\n\n`;
  const budget = maxChars - marker.length;
  if (budget <= 0) {
    // Degenerate cap smaller than the marker — keep a head slice.
    return content.slice(0, maxChars);
  }
  const head = Math.ceil(budget / 2);
  const tail = budget - head;
  return content.slice(0, head) + marker + content.slice(content.length - tail);
}
