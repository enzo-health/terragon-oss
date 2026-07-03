import type { Story, StoryDefault } from "@ladle/react";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "./conversation";
import { Message, MessageAvatar, MessageContent, MessageText } from "./message";

function Surface({ children }: { children: React.ReactNode }) {
  return <div className="nauval-chat-surface p-6 max-w-2xl">{children}</div>;
}

function ScrollButton() {
  return (
    <ConversationScrollButton className="absolute bottom-3 left-1/2 -translate-x-1/2 flex size-8 items-center justify-center rounded-full bg-surface-elevated ring ring-border text-muted-foreground shadow-sm transition-opacity data-[at-bottom=true]:pointer-events-none data-[at-bottom=true]:opacity-0 hover:bg-accent">
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
        <path
          d="M12 5v14M5 12l7 7 7-7"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </ConversationScrollButton>
  );
}

const TRANSCRIPT: { role: "incoming" | "outgoing"; text: string }[] = [
  { role: "outgoing", text: "Set up the repo and run the test suite." },
  {
    role: "incoming",
    text: "Cloned `terragon-labs/terragon` and ran `pnpm install`.",
  },
  { role: "outgoing", text: "Now run the www tests." },
  {
    role: "incoming",
    text: "Running `pnpm -C apps/www test` — 214 passed, 0 failed.",
  },
  { role: "outgoing", text: "Great. Check the shared package too." },
  {
    role: "incoming",
    text: "`pnpm -C packages/shared test` — 98 passed. One flaky scheduled-thread test retried and passed.",
  },
  { role: "outgoing", text: "Push a checkpoint commit." },
  {
    role: "incoming",
    text: "Committed `chore: stabilize ACP session continuity` and pushed to `terragon/fca1cf`.",
  },
  { role: "outgoing", text: "Open a PR against main." },
  {
    role: "incoming",
    text: "Opened PR #269 with a conventional-commit title and a summary of the fence changes.",
  },
];

export const Empty: Story = () => (
  <Surface>
    <Conversation className="relative h-96 rounded-outer ring ring-border">
      <ConversationContent className="p-4">
        <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
          No messages yet.
        </div>
      </ConversationContent>
      <ScrollButton />
    </Conversation>
  </Surface>
);

export const Populated: Story = () => (
  <Surface>
    <Conversation className="relative h-96 rounded-outer ring ring-border">
      <ConversationContent className="p-4">
        {TRANSCRIPT.slice(0, 4).map((m, i) => (
          <Message key={i} type={m.role}>
            {m.role === "incoming" && <MessageAvatar>AI</MessageAvatar>}
            <MessageContent>
              <MessageText variant={m.role === "outgoing" ? "bubble" : "plain"}>
                {m.text}
              </MessageText>
            </MessageContent>
          </Message>
        ))}
      </ConversationContent>
      <ScrollButton />
    </Conversation>
  </Surface>
);

export const OverflowScrolls: Story = () => (
  <Surface>
    <Conversation className="relative h-96 rounded-outer ring ring-border">
      <ConversationContent className="p-4">
        {TRANSCRIPT.map((m, i) => (
          <Message key={i} type={m.role}>
            {m.role === "incoming" && <MessageAvatar>AI</MessageAvatar>}
            <MessageContent>
              <MessageText variant={m.role === "outgoing" ? "bubble" : "plain"}>
                {m.text}
              </MessageText>
            </MessageContent>
          </Message>
        ))}
      </ConversationContent>
      <ScrollButton />
    </Conversation>
  </Surface>
);

export const LongMessagesOverflow: Story = () => (
  <Surface>
    <Conversation className="relative h-96 rounded-outer ring ring-border">
      <ConversationContent className="p-4">
        <Message type="outgoing">
          <MessageContent>
            <MessageText variant="bubble">
              Explain the whole delivery loop and how resume works.
            </MessageText>
          </MessageContent>
        </Message>
        <Message type="incoming">
          <MessageAvatar>AI</MessageAvatar>
          <MessageContent>
            <MessageText variant="plain">
              {`The delivery loop is persist-then-publish: roughly seven Postgres round-trips run before the XADD, so the durable row always exists before any client sees a delta. AG-UI SSE carries the deltas; PartySocket carries only status and meta. Each thread has its own flush queue — the global mutex was removed on 2026-07-02 — and every viewer runs an independent XREAD loop.

Resume is ours because \`HttpAgent\` has no native resume or retry: it discards the SSE id and retry fields entirely. \`use-live-transcript.ts\` seeds a seq-cursor from \`?history=messages\`, opens the resume SSE stream via \`agent.runAgent\` with an explicit resume intent gated by \`shouldOpenResumeStream\`, and classifies typed \`RUN_ERROR\` into the error banner. The client resume stream also closes on the server's terminal event so a duplicate stop returns a 202 reconcile-ack instead of pinning the thread in \`working\`.`}
            </MessageText>
          </MessageContent>
        </Message>
        <Message type="outgoing">
          <MessageContent>
            <MessageText variant="bubble">
              And the three-edit recipe for a new part?
            </MessageText>
          </MessageContent>
        </Message>
        <Message type="incoming">
          <MessageAvatar>AI</MessageAvatar>
          <MessageContent>
            <MessageText variant="plain">
              {`Exactly three edits: (1) the daemon provider adapter emits the \`terragon.part\` variant, (2) the store fold adds one \`TranscriptItem\` case, (3) the registry adds one line plus a leaf. Zero server edits, zero schema migrations. Unknown parts fold to an \`unknown-part\` item and render a labeled fallback card — never dropped.`}
            </MessageText>
          </MessageContent>
        </Message>
      </ConversationContent>
      <ScrollButton />
    </Conversation>
  </Surface>
);

export default {
  title: "ai/conversation",
} satisfies StoryDefault;
