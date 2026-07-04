import type { Story, StoryDefault } from "@ladle/react";
import { useState } from "react";
import { Button } from "./button";
import {
  FeedbackBar,
  FeedbackBarAction,
  FeedbackBarContent,
  FeedbackBarDismiss,
  FeedbackBarIcon,
} from "./feedback-bar";

const Surface = ({ children }: { children: React.ReactNode }) => (
  <div className="nauval-chat-surface p-6 max-w-2xl">{children}</div>
);

const SparkleIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
  </svg>
);

const ThumbsUpIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M7 10v12" />
    <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z" />
  </svg>
);

const ThumbsDownIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M17 14V2" />
    <path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z" />
  </svg>
);

const CloseIcon = () => (
  <svg
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </svg>
);

export const Idle: Story = () => (
  <Surface>
    <FeedbackBar>
      <FeedbackBarIcon>
        <SparkleIcon />
      </FeedbackBarIcon>
      <FeedbackBarContent>Was this response helpful?</FeedbackBarContent>
      <FeedbackBarDismiss className="inline-flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground">
        <CloseIcon />
      </FeedbackBarDismiss>
    </FeedbackBar>
  </Surface>
);

export const WithActions: Story = () => (
  <Surface>
    <FeedbackBar>
      <FeedbackBarIcon>
        <SparkleIcon />
      </FeedbackBarIcon>
      <FeedbackBarContent>Was this response helpful?</FeedbackBarContent>
      <FeedbackBarAction>
        <Button variant="ghost" iconOnly aria-label="Helpful">
          <ThumbsUpIcon />
        </Button>
        <Button variant="ghost" iconOnly aria-label="Not helpful">
          <ThumbsDownIcon />
        </Button>
      </FeedbackBarAction>
      <FeedbackBarDismiss className="inline-flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground">
        <CloseIcon />
      </FeedbackBarDismiss>
    </FeedbackBar>
  </Surface>
);

export const TextAction: Story = () => (
  <Surface>
    <FeedbackBar>
      <FeedbackBarIcon>
        <SparkleIcon />
      </FeedbackBarIcon>
      <FeedbackBarContent>
        The agent opened pull request #269.
      </FeedbackBarContent>
      <FeedbackBarAction>
        <Button variant="secondary" className="h-7 px-2 text-xs">
          View PR
        </Button>
      </FeedbackBarAction>
      <FeedbackBarDismiss className="inline-flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground">
        <CloseIcon />
      </FeedbackBarDismiss>
    </FeedbackBar>
  </Surface>
);

export const LongContentOverflow: Story = () => (
  <Surface>
    <FeedbackBar className="w-full">
      <FeedbackBarIcon>
        <SparkleIcon />
      </FeedbackBarIcon>
      <FeedbackBarContent className="truncate">
        Rate limits reset in 4 minutes — the run was re-routed to
        claude-opus-4-8[1m] to keep the turn moving while the primary quota
        recovers.
      </FeedbackBarContent>
      <FeedbackBarDismiss className="inline-flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground">
        <CloseIcon />
      </FeedbackBarDismiss>
    </FeedbackBar>
  </Surface>
);

export const Dismissible: Story = () => {
  const [open, setOpen] = useState(true);
  return (
    <Surface>
      <div className="flex flex-col items-start gap-3">
        <FeedbackBar open={open} onOpenChange={setOpen}>
          <FeedbackBarIcon>
            <SparkleIcon />
          </FeedbackBarIcon>
          <FeedbackBarContent>Was this response helpful?</FeedbackBarContent>
          <FeedbackBarDismiss className="inline-flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground">
            <CloseIcon />
          </FeedbackBarDismiss>
        </FeedbackBar>
        {!open && (
          <Button variant="outline" onClick={() => setOpen(true)}>
            Show feedback bar
          </Button>
        )}
      </div>
    </Surface>
  );
};

export default {
  title: "ai/feedback-bar",
} satisfies StoryDefault;
