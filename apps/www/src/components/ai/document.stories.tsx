import type { Story, StoryDefault } from "@ladle/react";
import {
  Document,
  DocumentAction,
  DocumentContent,
  DocumentHeader,
  DocumentTitle,
  DocumentTrigger,
} from "./document";

const Surface = ({ children }: { children: React.ReactNode }) => (
  <div className="nauval-chat-surface p-6 max-w-2xl">{children}</div>
);

const ChevronIcon = () => (
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
    className="size-4 text-muted-foreground transition-transform duration-200 group-data-open/document:rotate-180"
  >
    <path d="m6 9 6 6 6-6" />
  </svg>
);

const Trigger = () => (
  <DocumentAction>
    <DocumentTrigger className="inline-flex size-7 items-center justify-center rounded hover:bg-accent">
      <ChevronIcon />
    </DocumentTrigger>
  </DocumentAction>
);

const SHORT_BODY = `# Resume policy

The resume path is chosen from the trusted POST response, not the SSE echo.`;

const LONG_BODY = `# Agent architecture redesign

## Goal

Collapse the transcript pipeline onto one canonical AG-UI stream so a new
renderable event costs exactly three edits.

## K1 — canonical-only wire

The daemon mints its own AG-UI identity and emits standard rows plus
terragon.part rich rows directly. The legacy stream-json transport is gone.

## K2 — typed recoverable terminals

RUN_ERROR carries a typed, recoverable classification. The client folds it into
an error banner leaf instead of a hard crash.

## K3 — ingest pipeline stages

Persist-then-publish: roughly seven Postgres round-trips land before the XADD,
so a viewer that reconnects mid-turn replays from the seq cursor cleanly.

## K4 — durable meta

Token usage, rate limits, model re-routing and MCP health ride the durable
ThreadMetaEvent channel and render as header chips.

## Open follow-ups

Hop 2b wires the fence and usage passthrough end to end. The integration
harness replays recorded daemon-event traffic through the real Next.js route so
CI stays deterministic without a live sandbox.`;

export const Collapsed: Story = () => (
  <Surface>
    <Document>
      <DocumentHeader>
        <DocumentTitle>docs/plans/agent-architecture-redesign.md</DocumentTitle>
        <Trigger />
      </DocumentHeader>
      <DocumentContent>
        <div className="whitespace-pre-wrap text-sm text-foreground">
          {LONG_BODY}
        </div>
      </DocumentContent>
    </Document>
  </Surface>
);

export const Expanded: Story = () => (
  <Surface>
    <Document defaultOpen>
      <DocumentHeader>
        <DocumentTitle>docs/plans/agent-architecture-redesign.md</DocumentTitle>
        <Trigger />
      </DocumentHeader>
      <DocumentContent>
        <div className="whitespace-pre-wrap text-sm text-foreground">
          {LONG_BODY}
        </div>
      </DocumentContent>
    </Document>
  </Surface>
);

export const ShortContent: Story = () => (
  <Surface>
    <Document defaultOpen>
      <DocumentHeader>
        <DocumentTitle>notes.md</DocumentTitle>
        <Trigger />
      </DocumentHeader>
      <DocumentContent>
        <div className="whitespace-pre-wrap text-sm text-foreground">
          {SHORT_BODY}
        </div>
      </DocumentContent>
    </Document>
  </Surface>
);

export const CollapsedShortContent: Story = () => (
  <Surface>
    <Document>
      <DocumentHeader>
        <DocumentTitle>notes.md</DocumentTitle>
        <Trigger />
      </DocumentHeader>
      <DocumentContent>
        <div className="whitespace-pre-wrap text-sm text-foreground">
          {SHORT_BODY}
        </div>
      </DocumentContent>
    </Document>
  </Surface>
);

export const CustomCollapsedHeight: Story = () => (
  <Surface>
    <Document collapsedHeight={120}>
      <DocumentHeader>
        <DocumentTitle>docs/plans/agent-architecture-redesign.md</DocumentTitle>
        <Trigger />
      </DocumentHeader>
      <DocumentContent>
        <div className="whitespace-pre-wrap text-sm text-foreground">
          {LONG_BODY}
        </div>
      </DocumentContent>
    </Document>
  </Surface>
);

export default {
  title: "ai/document",
} satisfies StoryDefault;
