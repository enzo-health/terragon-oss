import type { Story, StoryDefault } from "@ladle/react";
import {
  CodeBlock,
  CodeBlockAction,
  CodeBlockContent,
  CodeBlockHeader,
  CodeBlockTitle,
  CodeBlockTrigger,
} from "./code-block";

function Surface({ children }: { children: React.ReactNode }) {
  return <div className="nauval-chat-surface p-6 max-w-2xl">{children}</div>;
}

function CopyButton() {
  return (
    <button
      type="button"
      className="text-muted-foreground hover:text-foreground"
    >
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        aria-hidden
      >
        <rect x="9" y="9" width="13" height="13" rx="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </svg>
    </button>
  );
}

const SHORT_TS = `export function resume(id: string) {
  return getSession(id).run();
}`;

const LONG_TS = `import { getSession } from "./session";
import { logger } from "./logger";
import { metrics } from "./metrics";

export async function resume(id: string): Promise<RunHandle> {
  const handle = await getSession(id);
  if (!handle) {
    logger.warn("no session for", id);
    return startResume(id);
  }
  metrics.increment("resume.hit");
  return handle.run();
}

export function shutdown() {
  metrics.flush();
  logger.info("shutdown complete");
}

export function boot(config: BootConfig) {
  logger.info("booting", config.provider);
  return createSandbox(config);
}

export function hibernate(id: string) {
  return getSession(id).pause();
}`;

const JSON_SNIPPET = `{
  "provider": "e2b",
  "timeoutMs": 30000,
  "retries": 3
}`;

const SHELL_SNIPPET = `pnpm -C apps/www test
pnpm -C packages/shared drizzle-kit-push-dev`;

export const Basic: Story = () => (
  <Surface>
    <CodeBlock>
      <CodeBlockContent>
        <pre>{SHORT_TS}</pre>
      </CodeBlockContent>
    </CodeBlock>
  </Surface>
);

export const WithHeaderAndAction: Story = () => (
  <Surface>
    <CodeBlock>
      <CodeBlockHeader>
        <CodeBlockTitle>src/agent/orchestrator.ts</CodeBlockTitle>
        <CodeBlockAction>
          <CopyButton />
        </CodeBlockAction>
      </CodeBlockHeader>
      <CodeBlockContent>
        <pre>{SHORT_TS}</pre>
      </CodeBlockContent>
    </CodeBlock>
  </Surface>
);

export const ShortNoClip: Story = () => (
  <Surface>
    <CodeBlock clip maxHeight={240}>
      <CodeBlockHeader>
        <CodeBlockTitle>typescript</CodeBlockTitle>
      </CodeBlockHeader>
      <CodeBlockContent>
        <pre>{SHORT_TS}</pre>
      </CodeBlockContent>
      <CodeBlockTrigger className="px-3 h-8 text-xs text-muted-foreground hover:text-foreground text-left">
        Show more
      </CodeBlockTrigger>
    </CodeBlock>
  </Surface>
);

export const ClippedOverflow: Story = () => (
  <Surface>
    <CodeBlock clip maxHeight={140}>
      <CodeBlockHeader>
        <CodeBlockTitle>typescript</CodeBlockTitle>
        <CodeBlockAction>
          <CopyButton />
        </CodeBlockAction>
      </CodeBlockHeader>
      <CodeBlockContent>
        <pre>{LONG_TS}</pre>
      </CodeBlockContent>
      <CodeBlockTrigger className="px-3 h-8 text-xs text-muted-foreground hover:text-foreground text-left">
        Show more
      </CodeBlockTrigger>
    </CodeBlock>
  </Surface>
);

export const ExpandedDefaultOpen: Story = () => (
  <Surface>
    <CodeBlock clip defaultOpen maxHeight={140}>
      <CodeBlockHeader>
        <CodeBlockTitle>typescript</CodeBlockTitle>
        <CodeBlockAction>
          <CopyButton />
        </CodeBlockAction>
      </CodeBlockHeader>
      <CodeBlockContent>
        <pre>{LONG_TS}</pre>
      </CodeBlockContent>
      <CodeBlockTrigger className="px-3 h-8 text-xs text-muted-foreground hover:text-foreground text-left">
        Show less
      </CodeBlockTrigger>
    </CodeBlock>
  </Surface>
);

export const LanguageVariants: Story = () => (
  <Surface>
    <div className="space-y-3">
      <CodeBlock>
        <CodeBlockHeader>
          <CodeBlockTitle>json</CodeBlockTitle>
        </CodeBlockHeader>
        <CodeBlockContent>
          <pre>{JSON_SNIPPET}</pre>
        </CodeBlockContent>
      </CodeBlock>
      <CodeBlock>
        <CodeBlockHeader>
          <CodeBlockTitle>shell</CodeBlockTitle>
        </CodeBlockHeader>
        <CodeBlockContent>
          <pre>{SHELL_SNIPPET}</pre>
        </CodeBlockContent>
      </CodeBlock>
      <CodeBlock>
        <CodeBlockHeader>
          <CodeBlockTitle>typescript</CodeBlockTitle>
        </CodeBlockHeader>
        <CodeBlockContent>
          <pre>{SHORT_TS}</pre>
        </CodeBlockContent>
      </CodeBlock>
    </div>
  </Surface>
);

export const LongLineOverflow: Story = () => (
  <Surface>
    <CodeBlock>
      <CodeBlockHeader>
        <CodeBlockTitle>shell</CodeBlockTitle>
      </CodeBlockHeader>
      <CodeBlockContent>
        <pre className="whitespace-pre-wrap wrap-break-word">
          {`curl -sSL https://example.com/install.sh | bash -s -- --provider=e2b --timeout=30000 --retries=3 --region=us-east-1 --verbose --no-cache`}
        </pre>
      </CodeBlockContent>
    </CodeBlock>
  </Surface>
);

export default {
  title: "ai/code-block",
} satisfies StoryDefault;
