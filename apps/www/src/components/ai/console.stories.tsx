import type { Story, StoryDefault } from "@ladle/react";
import {
  Console,
  ConsoleContent,
  ConsoleEntry,
  type ConsoleLevel,
  ConsoleList,
  ConsoleSource,
  ConsoleStack,
  ConsoleStackContent,
  ConsoleStackTrigger,
  ConsoleTimestamp,
} from "./console";

function Surface({ children }: { children: React.ReactNode }) {
  return <div className="nauval-chat-surface p-6 max-w-2xl">{children}</div>;
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-outer bg-surface ring ring-border overflow-hidden">
      {children}
    </div>
  );
}

type Line = {
  level: ConsoleLevel;
  time: string;
  text: string;
  source?: string;
};

const MIXED: Line[] = [
  { level: "info", time: "12:04:01", text: "Booting sandbox (provider=e2b)" },
  { level: "log", time: "12:04:02", text: "Cloned terragon-labs/terragon" },
  {
    level: "debug",
    time: "12:04:02",
    text: "resolved 1284 packages",
    source: "pnpm",
  },
  { level: "log", time: "12:04:09", text: "pnpm install completed in 6.8s" },
  {
    level: "warn",
    time: "12:04:10",
    text: "peer dep react@19 unmet for legacy-plugin",
  },
  { level: "log", time: "12:04:12", text: "Running pnpm -C apps/www test" },
  {
    level: "error",
    time: "12:04:41",
    text: "1 test failed: route.test.ts > history projection",
  },
];

const STDOUT: Line[] = [
  { level: "log", time: "09:15:30", text: "next dev --turbopack" },
  { level: "info", time: "09:15:31", text: "ready on http://localhost:3000" },
  { level: "log", time: "09:15:33", text: "compiled /chat in 812ms" },
  {
    level: "log",
    time: "09:15:40",
    text: "GET /api/ag-ui/thr_9f2 200 in 41ms",
  },
];

const STDERR: Line[] = [
  {
    level: "warn",
    time: "09:16:02",
    text: "seq cursor 4821 behind checkpoint 4930",
  },
  {
    level: "error",
    time: "09:16:02",
    text: "RUN_ERROR: replay window evicted before reconnect",
  },
  {
    level: "error",
    time: "09:16:03",
    text: "ECONNRESET writing daemon-event POST",
  },
];

function renderEntries(lines: Line[]) {
  return (
    <ConsoleList>
      {lines.map((line, i) => (
        <ConsoleEntry key={i} level={line.level}>
          <ConsoleTimestamp>{line.time}</ConsoleTimestamp>
          <span className="min-w-0 flex-1 break-words">{line.text}</span>
          {line.source && <ConsoleSource>{line.source}</ConsoleSource>}
        </ConsoleEntry>
      ))}
    </ConsoleList>
  );
}

export const MixedOutput: Story = () => (
  <Surface>
    <Frame>
      <Console>
        <ConsoleContent>{renderEntries(MIXED)}</ConsoleContent>
      </Console>
    </Frame>
  </Surface>
);

export const StdoutOnly: Story = () => (
  <Surface>
    <Frame>
      <Console>
        <ConsoleContent>{renderEntries(STDOUT)}</ConsoleContent>
      </Console>
    </Frame>
  </Surface>
);

export const StderrErrors: Story = () => (
  <Surface>
    <Frame>
      <Console>
        <ConsoleContent>{renderEntries(STDERR)}</ConsoleContent>
      </Console>
    </Frame>
  </Surface>
);

export const AllLevels: Story = () => {
  const levels: ConsoleLevel[] = ["log", "info", "warn", "error", "debug"];
  return (
    <Surface>
      <Frame>
        <Console>
          <ConsoleContent>
            <ConsoleList>
              {levels.map((level) => (
                <ConsoleEntry key={level} level={level}>
                  <ConsoleTimestamp>12:00:00</ConsoleTimestamp>
                  <span className="min-w-0 flex-1">
                    {level} level message from the daemon
                  </span>
                  <ConsoleSource>{level}</ConsoleSource>
                </ConsoleEntry>
              ))}
            </ConsoleList>
          </ConsoleContent>
        </Console>
      </Frame>
    </Surface>
  );
};

const STACK = `Error: replay window evicted before reconnect
    at HttpAgent.runAgent (ag-ui/client/http-agent.ts:214:19)
    at useLiveTranscript.openResumeStream (use-live-transcript.ts:388:12)
    at commitTerminal (route.ts:864:7)
    at async dispatchFollowUpFromAppend (follow-up.ts:52:3)`;

export const WithStackTraceCollapsed: Story = () => (
  <Surface>
    <Frame>
      <Console>
        <ConsoleContent>
          <ConsoleList>
            <ConsoleEntry level="error">
              <ConsoleTimestamp>09:16:02</ConsoleTimestamp>
              <ConsoleStack>
                <ConsoleStackTrigger>
                  RUN_ERROR: replay window evicted before reconnect
                </ConsoleStackTrigger>
                <ConsoleStackContent>{STACK}</ConsoleStackContent>
              </ConsoleStack>
            </ConsoleEntry>
          </ConsoleList>
        </ConsoleContent>
      </Console>
    </Frame>
  </Surface>
);

export const WithStackTraceExpanded: Story = () => (
  <Surface>
    <Frame>
      <Console>
        <ConsoleContent>
          <ConsoleList>
            <ConsoleEntry level="error">
              <ConsoleTimestamp>09:16:02</ConsoleTimestamp>
              <ConsoleStack defaultOpen>
                <ConsoleStackTrigger>
                  RUN_ERROR: replay window evicted before reconnect
                </ConsoleStackTrigger>
                <ConsoleStackContent>{STACK}</ConsoleStackContent>
              </ConsoleStack>
            </ConsoleEntry>
          </ConsoleList>
        </ConsoleContent>
      </Console>
    </Frame>
  </Surface>
);

export const OverflowScrolls: Story = () => {
  const lines: Line[] = Array.from({ length: 60 }, (_, i) => {
    const levels: ConsoleLevel[] = ["log", "info", "debug", "warn", "error"];
    const level = levels[i % levels.length]!;
    return {
      level,
      time: `12:${String(4 + Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}`,
      text: `GET /api/ag-ui/thr_9f2 200 in ${20 + i}ms — flushed ${i} deltas`,
      source: level,
    };
  });
  return (
    <Surface>
      <Frame>
        <Console className="h-72">
          <ConsoleContent>{renderEntries(lines)}</ConsoleContent>
        </Console>
      </Frame>
    </Surface>
  );
};

export const Empty: Story = () => (
  <Surface>
    <Frame>
      <Console className="h-40">
        <ConsoleContent>
          <div className="flex h-40 items-center justify-center text-xs text-muted-foreground">
            No output yet.
          </div>
        </ConsoleContent>
      </Console>
    </Frame>
  </Surface>
);

export default {
  title: "ai/console",
} satisfies StoryDefault;
