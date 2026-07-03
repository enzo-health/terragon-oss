import type { Story, StoryDefault } from "@ladle/react";
import {
  Message,
  MessageAction,
  MessageAvatar,
  MessageContent,
  MessageText,
} from "./message";

function Surface({ children }: { children: React.ReactNode }) {
  return <div className="nauval-chat-surface p-6 max-w-2xl">{children}</div>;
}

function CopyButton() {
  return (
    <button
      type="button"
      className="rounded-md p-1.5 text-muted-foreground hover:bg-accent"
      aria-label="Copy message"
    >
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
        <rect
          x="9"
          y="9"
          width="11"
          height="11"
          rx="2"
          stroke="currentColor"
          strokeWidth="2"
        />
        <path
          d="M5 15V5a2 2 0 0 1 2-2h10"
          stroke="currentColor"
          strokeWidth="2"
        />
      </svg>
    </button>
  );
}

export const OutgoingBubble: Story = () => (
  <Surface>
    <Message type="outgoing">
      <MessageContent>
        <MessageText variant="bubble">
          Fix the failing test in `packages/shared/src/db/db-message.test.ts` —
          the schema version assertion is off by one.
        </MessageText>
      </MessageContent>
    </Message>
  </Surface>
);

export const IncomingPlain: Story = () => (
  <Surface>
    <Message type="incoming">
      <MessageAvatar>AI</MessageAvatar>
      <MessageContent>
        <MessageText variant="plain">
          I bumped `DB_MESSAGE_SCHEMA_VERSION` to 12 and updated the assertion.
          The test passes now. Want me to run the full suite in
          `packages/shared`?
        </MessageText>
      </MessageContent>
    </Message>
  </Surface>
);

export const IncomingWithAvatarImage: Story = () => (
  <Surface>
    <Message type="incoming">
      <MessageAvatar>
        <img src="https://github.com/nauvalazhar.png" alt="Assistant" />
      </MessageAvatar>
      <MessageContent>
        <MessageText variant="plain">
          Cloned `terragon-labs/terragon`, installed dependencies, and started
          the dev server on port 3000.
        </MessageText>
      </MessageContent>
    </Message>
  </Surface>
);

export const IncomingWithActions: Story = () => (
  <Surface>
    <Message type="incoming">
      <MessageAvatar>AI</MessageAvatar>
      <MessageContent>
        <MessageText variant="plain">
          Ran `pnpm -C apps/www test` — 214 passed, 0 failed. The optimistic
          overlay registry change is covered by the new route tests.
        </MessageText>
        <MessageAction>
          <CopyButton />
        </MessageAction>
      </MessageContent>
    </Message>
  </Surface>
);

export const OutgoingWithActions: Story = () => (
  <Surface>
    <Message type="outgoing">
      <MessageContent>
        <MessageText variant="bubble">
          Now open a PR against `main` with a conventional-commit title.
        </MessageText>
        <MessageAction>
          <CopyButton />
        </MessageAction>
      </MessageContent>
    </Message>
  </Surface>
);

export const IncomingCodeHeavy: Story = () => (
  <Surface>
    <Message type="incoming">
      <MessageAvatar>AI</MessageAvatar>
      <MessageContent>
        <MessageText variant="plain">
          {`Here's the diff I applied:

    - const version = 11;
    + const version = 12;

You can verify with \`git diff packages/shared/src/db/db-message.ts\`. The change is type-level plus one constant bump, no runtime behavior change.`}
        </MessageText>
      </MessageContent>
    </Message>
  </Surface>
);

export const LongContentOverflow: Story = () => (
  <Surface>
    <Message type="incoming">
      <MessageAvatar>AI</MessageAvatar>
      <MessageContent>
        <MessageText variant="plain">
          {`I traced the stuck-\`working\` thread bug end to end. The turn-completion signal was riding solely on the SSE echo, so when the browser tab throttled the EventSource the run never flipped to \`complete\`. The daemon's POST response already carries the trusted terminal event, so I now read that too and reconcile against the SSE stream. This closes the race where a duplicate stop returns a 202 reconcile-ack instead of leaving the thread pinned. I also fenced the terminal-recovery path at the daemon-event route so recovery can't fire after the run-context terminal fence has run — that was the \`terminalRecoveryQueued never fenced\` class of bug. Long single tokens like supercalifragilisticexpialidocioussandboxidentifierthatwillnotwrapnicely should still wrap without breaking the max-width column.`}
        </MessageText>
      </MessageContent>
    </Message>
  </Surface>
);

export const Conversation: Story = () => (
  <Surface>
    <div className="flex flex-col gap-6">
      <Message type="outgoing">
        <MessageContent>
          <MessageText variant="bubble">
            What does `handleAgUiPostCommand()` do?
          </MessageText>
        </MessageContent>
      </Message>
      <Message type="incoming">
        <MessageAvatar>AI</MessageAvatar>
        <MessageContent>
          <MessageText variant="plain">
            It parses AG-UI command bodies on `POST /api/ag-ui/[threadId]`,
            dispatches appends through `dispatchFollowUpFromAppend()` →
            `followUpInternal()`, and falls through to the GET SSE path for
            bodyless, replay, and resume POSTs.
          </MessageText>
          <MessageAction>
            <CopyButton />
          </MessageAction>
        </MessageContent>
      </Message>
      <Message type="outgoing">
        <MessageContent>
          <MessageText variant="bubble">
            Thanks — where does cancel route?
          </MessageText>
        </MessageContent>
      </Message>
      <Message type="incoming">
        <MessageAvatar>AI</MessageAvatar>
        <MessageContent>
          <MessageText variant="plain">
            Through the AG-UI cancel endpoint → `cancelThreadFromAgUiInput()` →
            `stopThreadInternal()`.
          </MessageText>
        </MessageContent>
      </Message>
    </div>
  </Surface>
);

export default {
  title: "ai/message",
} satisfies StoryDefault;
