import type { Story, StoryDefault } from "@ladle/react";
import { Callout, CalloutContent, CalloutIcon } from "./callout";

const InfoIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" strokeLinecap="round" />
  </svg>
);

const WarningIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path
      d="M10.3 3.9 1.8 18a1.7 1.7 0 0 0 1.5 2.6h17.4a1.7 1.7 0 0 0 1.5-2.6L13.7 3.9a1.7 1.7 0 0 0-3 0Z"
      strokeLinejoin="round"
    />
    <path d="M12 9v4M12 17h.01" strokeLinecap="round" />
  </svg>
);

const DangerIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <circle cx="12" cy="12" r="9" />
    <path d="M12 8v5M12 16h.01" strokeLinecap="round" />
  </svg>
);

const surface = (children: React.ReactNode) => (
  <div className="nauval-chat-surface p-6 max-w-2xl">{children}</div>
);

export const Info: Story = () =>
  surface(
    <Callout tone="info">
      <CalloutIcon>
        <InfoIcon />
      </CalloutIcon>
      <CalloutContent>
        <p>
          The sandbox was resumed from hibernation. Run{" "}
          <code>pnpm install</code> if dependencies changed since it was paused.
        </p>
      </CalloutContent>
    </Callout>,
  );

export const Warning: Story = () =>
  surface(
    <Callout tone="warning">
      <CalloutIcon>
        <WarningIcon />
      </CalloutIcon>
      <CalloutContent>
        <p>
          You are approaching your Claude rate limit. Requests may be re-routed
          to a fallback model until the window resets.
        </p>
      </CalloutContent>
    </Callout>,
  );

export const Danger: Story = () =>
  surface(
    <Callout tone="danger">
      <CalloutIcon>
        <DangerIcon />
      </CalloutIcon>
      <CalloutContent>
        <p>
          The agent could not push to <code>origin/main</code>: the branch is
          protected. Open a pull request instead.
        </p>
      </CalloutContent>
    </Callout>,
  );

export const Iconless: Story = () =>
  surface(
    <Callout tone="info">
      <CalloutContent>
        <p>No sandbox provider is configured for this environment yet.</p>
      </CalloutContent>
    </Callout>,
  );

export const MultiParagraph: Story = () =>
  surface(
    <Callout tone="warning">
      <CalloutIcon>
        <WarningIcon />
      </CalloutIcon>
      <CalloutContent>
        <p>The setup script exited with a non-zero status.</p>
        <p>
          The agent will continue, but tools that depend on{" "}
          <code>node_modules</code> may fail until you re-run{" "}
          <code>pnpm install</code> manually.
        </p>
      </CalloutContent>
    </Callout>,
  );

export const LongContentOverflow: Story = () =>
  surface(
    <Callout tone="danger">
      <CalloutIcon>
        <DangerIcon />
      </CalloutIcon>
      <CalloutContent>
        <p>
          The daemon reported a fatal error while streaming AG-UI events:{" "}
          <code>
            RUN_ERROR: seq cursor 4821 is behind the server checkpoint 4930; the
            replay window was evicted before the client reconnected
          </code>
          . The transcript has been reconciled from the last durable message,
          but any tool output emitted between those cursors is unrecoverable.
        </p>
      </CalloutContent>
    </Callout>,
  );

export const AllTones: Story = () =>
  surface(
    <div className="space-y-3">
      <Callout tone="info">
        <CalloutIcon>
          <InfoIcon />
        </CalloutIcon>
        <CalloutContent>
          <p>Booting environment and cloning the repository.</p>
        </CalloutContent>
      </Callout>
      <Callout tone="warning">
        <CalloutIcon>
          <WarningIcon />
        </CalloutIcon>
        <CalloutContent>
          <p>MCP server &quot;linear&quot; is degraded; tools may be slow.</p>
        </CalloutContent>
      </Callout>
      <Callout tone="danger">
        <CalloutIcon>
          <DangerIcon />
        </CalloutIcon>
        <CalloutContent>
          <p>The run was cancelled before it produced a checkpoint.</p>
        </CalloutContent>
      </Callout>
    </div>,
  );

export default {
  title: "ai/callout",
} satisfies StoryDefault;
