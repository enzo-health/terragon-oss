export type SlackSessionCommand =
  | { type: "archive" }
  | { type: "aside"; text: string }
  | { type: "help" }
  | { type: "mute" }
  | { type: "resume" }
  | { type: "sleep"; until: Date | null }
  | { type: "status" }
  | { type: "stop" }
  | { type: "unmute" }
  | { type: "wake" };

const DURATION_RE = /^(\d+)\s*(m|min|minute|minutes|h|hr|hour|hours)$/i;

function parseDuration(value: string, now: Date): Date | null {
  const match = value.trim().match(DURATION_RE);
  if (!match) {
    return null;
  }
  const amount = Number(match[1]);
  const unit = (match[2] ?? "m").toLowerCase();
  const multiplier = unit.startsWith("h") ? 60 * 60 * 1000 : 60 * 1000;
  return new Date(now.getTime() + amount * multiplier);
}

export function parseSlackSessionCommand(
  text: string,
  now = new Date(),
): SlackSessionCommand | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }

  const asideMatch =
    trimmed.match(/^\(aside\)\s*(.*)$/i) ?? trimmed.match(/^!aside\s*(.*)$/i);
  if (asideMatch) {
    return { type: "aside", text: asideMatch[1]?.trim() ?? "" };
  }

  const lower = trimmed.toLowerCase();
  if (lower === "archive") return { type: "archive" };
  if (lower === "exit" || lower === "stop") return { type: "stop" };
  if (lower === "help") return { type: "help" };
  if (lower === "mute") return { type: "mute" };
  if (lower === "resume") return { type: "resume" };
  if (lower === "status") return { type: "status" };
  if (lower === "unmute") return { type: "unmute" };
  if (lower === "wake") return { type: "wake" };
  if (lower === "sleep") return { type: "sleep", until: null };

  const sleepMatch = trimmed.match(/^sleep\s+(.+)$/i);
  if (sleepMatch) {
    const until = parseDuration(sleepMatch[1] ?? "", now);
    return until ? { type: "sleep", until } : null;
  }

  return null;
}

export function isWakeAllowedWhileSleeping(
  command: SlackSessionCommand | null,
): boolean {
  return (
    command?.type === "wake" ||
    command?.type === "resume" ||
    command?.type === "status" ||
    command?.type === "help"
  );
}
