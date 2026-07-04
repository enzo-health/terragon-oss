import type { Story, StoryDefault } from "@ladle/react";
import { Markdown } from "./markdown";

function Surface({ children }: { children: React.ReactNode }) {
  return <div className="nauval-chat-surface p-6 max-w-2xl">{children}</div>;
}

const HEADINGS = `# Delivery loop

## Persist then publish

### Ordering guarantee

The durable row always exists before any client sees a delta. Roughly seven
Postgres round-trips run before the \`XADD\`.`;

const LISTS = `Here is what the resume path does:

1. Seed a seq-cursor from \`?history=messages\`
2. Subscribe to the \`HttpAgent\` event stream
3. Open the resume SSE stream via \`agent.runAgent\`

Unordered notes:

- \`HttpAgent\` has no native resume or retry
- The seq-cursor replay stack is ours
- Unknown parts fold to a labeled fallback card
  - never dropped
  - always rendered`;

const CODE = `The store fold is one pure function:

\`\`\`typescript
export function fold(state: TranscriptStore, event: AgUiEvent): TranscriptStore {
  switch (event.type) {
    case "TEXT_MESSAGE_CONTENT":
      return appendText(state, event);
    default:
      return foldUnknown(state, event);
  }
}
\`\`\`

Inline code like \`routeComposerSubmit\` renders too.`;

const TABLE = `Provider support matrix:

| Provider | Sandbox | Resume | Status |
| -------- | ------- | ------ | ------ |
| Claude   | E2B     | yes    | stable |
| Codex    | Daytona | yes    | beta   |
| Docker   | local   | no     | test   |`;

const RICH = `# AG-UI transcript

The transcript renders through a **pure store fold** and a _typed leaf
registry_. See [the plan of record](https://example.com/plan) for details.

## Feature recipe

A new renderable agent event costs exactly **three edits**:

1. the daemon provider adapter emits the \`terragon.part\` variant
2. the store fold adds one \`TranscriptItem\` case
3. the registry adds one line plus a leaf

> Zero server edits, zero schema migrations.

| Edit | File                     |
| ---- | ------------------------ |
| 1    | provider adapter         |
| 2    | transcript-store fold    |
| 3    | transcript-view registry |

\`\`\`json
{ "kind": "unknown-part", "fallback": true }
\`\`\`

---

That is the whole surface area.`;

const STREAMING = `Streaming a fenced block that has not closed yet:

\`\`\`typescript
export async function resume(id: string) {
  const handle = await getSession(id);
  if (!handle) {
    return startResume(id`;

export const Headings: Story = () => (
  <Surface>
    <Markdown>{HEADINGS}</Markdown>
  </Surface>
);

export const Lists: Story = () => (
  <Surface>
    <Markdown>{LISTS}</Markdown>
  </Surface>
);

export const CodeBlocks: Story = () => (
  <Surface>
    <Markdown>{CODE}</Markdown>
  </Surface>
);

export const Table: Story = () => (
  <Surface>
    <Markdown>{TABLE}</Markdown>
  </Surface>
);

export const KitchenSink: Story = () => (
  <Surface>
    <Markdown>{RICH}</Markdown>
  </Surface>
);

export const StreamingIncompleteFence: Story = () => (
  <Surface>
    <Markdown>{STREAMING}</Markdown>
  </Surface>
);

export const Empty: Story = () => (
  <Surface>
    <Markdown>{""}</Markdown>
  </Surface>
);

export default {
  title: "ai/markdown",
} satisfies StoryDefault;
