import type { Story, StoryDefault } from "@ladle/react";
import { ScrollArea } from "./scroll-area";

function Surface({ children }: { children: React.ReactNode }) {
  return <div className="nauval-chat-surface p-6 max-w-2xl">{children}</div>;
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-outer bg-surface ring ring-border">{children}</div>
  );
}

const ROWS = Array.from({ length: 40 }, (_, i) => ({
  id: i,
  label: `GET /api/ag-ui/thr_9f2 200 in ${20 + i}ms — flushed ${i} deltas`,
}));

const WIDE_LINE =
  "curl -sSL https://example.com/install.sh | bash -s -- --provider=e2b --timeout=30000 --retries=3 --region=us-east-1 --verbose --no-cache --branch=chore/aa";

export const VerticalOverflow: Story = () => (
  <Surface>
    <Frame>
      <ScrollArea scrollbar="vertical" className="h-72">
        <ul className="divide-y divide-border font-mono text-xs">
          {ROWS.map((row) => (
            <li key={row.id} className="px-4 py-2 text-foreground/80">
              {row.label}
            </li>
          ))}
        </ul>
      </ScrollArea>
    </Frame>
  </Surface>
);

export const HorizontalOverflow: Story = () => (
  <Surface>
    <Frame>
      <ScrollArea scrollbar="horizontal" className="w-full">
        <pre className="w-max px-4 py-3 font-mono text-xs text-foreground/80">
          {WIDE_LINE}
        </pre>
      </ScrollArea>
    </Frame>
  </Surface>
);

export const BothOverflow: Story = () => (
  <Surface>
    <Frame>
      <ScrollArea scrollbar="both" className="h-72 w-full">
        <div className="w-max font-mono text-xs">
          {ROWS.map((row) => (
            <div
              key={row.id}
              className="px-4 py-2 whitespace-nowrap text-foreground/80"
            >
              {row.label} — {WIDE_LINE}
            </div>
          ))}
        </div>
      </ScrollArea>
    </Frame>
  </Surface>
);

export const NoScrollbar: Story = () => (
  <Surface>
    <Frame>
      <ScrollArea scrollbar={false} className="h-72">
        <ul className="divide-y divide-border font-mono text-xs">
          {ROWS.map((row) => (
            <li key={row.id} className="px-4 py-2 text-foreground/80">
              {row.label}
            </li>
          ))}
        </ul>
      </ScrollArea>
    </Frame>
  </Surface>
);

export const FitContent: Story = () => (
  <Surface>
    <Frame>
      <ScrollArea scrollbar="vertical" fitContent className="max-h-72">
        <ul className="divide-y divide-border font-mono text-xs">
          {ROWS.slice(0, 30).map((row) => (
            <li key={row.id} className="px-4 py-2 text-foreground/80">
              {row.label}
            </li>
          ))}
        </ul>
      </ScrollArea>
    </Frame>
  </Surface>
);

export const NoOverflow: Story = () => (
  <Surface>
    <Frame>
      <ScrollArea scrollbar="vertical" className="h-72">
        <ul className="divide-y divide-border font-mono text-xs">
          {ROWS.slice(0, 4).map((row) => (
            <li key={row.id} className="px-4 py-2 text-foreground/80">
              {row.label}
            </li>
          ))}
        </ul>
      </ScrollArea>
    </Frame>
  </Surface>
);

export default {
  title: "ai/scroll-area",
} satisfies StoryDefault;
