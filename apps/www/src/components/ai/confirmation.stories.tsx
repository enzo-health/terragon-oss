import type { Story, StoryDefault } from "@ladle/react";
import {
  Confirmation,
  ConfirmationAccept,
  ConfirmationAction,
  ConfirmationApproved,
  ConfirmationContent,
  ConfirmationDescription,
  ConfirmationHeader,
  ConfirmationIcon,
  ConfirmationPending,
  ConfirmationReject,
  ConfirmationRejected,
  ConfirmationStatus,
  ConfirmationTitle,
} from "./confirmation";

const ShieldIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path
      d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const CheckIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="m5 12 5 5 9-9" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const XIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path
      d="M6 6 18 18M18 6 6 18"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const acceptClass =
  "inline-flex h-8 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground hover:bg-primary/90";
const rejectClass =
  "inline-flex h-8 items-center rounded-md px-3 text-sm font-medium text-muted-foreground ring ring-border hover:bg-muted";

const CommandBody = () => (
  <>
    <ConfirmationDescription>
      The agent wants to run the following command in the sandbox:
    </ConfirmationDescription>
    <ConfirmationContent>
      <pre className="overflow-x-auto rounded bg-surface-elevated px-3 py-2 font-mono text-xs text-foreground ring ring-border">
        rm -rf node_modules && pnpm install --frozen-lockfile
      </pre>
    </ConfirmationContent>
  </>
);

const surface = (children: React.ReactNode) => (
  <div className="nauval-chat-surface p-6 max-w-2xl">{children}</div>
);

export const Pending: Story = () =>
  surface(
    <Confirmation state="pending">
      <ConfirmationHeader>
        <ConfirmationIcon>
          <ShieldIcon />
        </ConfirmationIcon>
        <ConfirmationTitle>Run bash command?</ConfirmationTitle>
      </ConfirmationHeader>
      <CommandBody />
      <ConfirmationPending>
        <ConfirmationAction>
          <ConfirmationReject className={rejectClass}>Deny</ConfirmationReject>
          <ConfirmationAccept className={acceptClass}>Allow</ConfirmationAccept>
        </ConfirmationAction>
      </ConfirmationPending>
    </Confirmation>,
  );

export const PendingDangerTone: Story = () =>
  surface(
    <Confirmation state="pending" tone="danger">
      <ConfirmationHeader>
        <ConfirmationIcon>
          <ShieldIcon />
        </ConfirmationIcon>
        <ConfirmationTitle>Force-push to main?</ConfirmationTitle>
      </ConfirmationHeader>
      <ConfirmationDescription>
        This rewrites remote history on <code>origin/main</code> and cannot be
        undone.
      </ConfirmationDescription>
      <ConfirmationContent>
        <pre className="overflow-x-auto rounded bg-surface-elevated px-3 py-2 font-mono text-xs text-foreground ring ring-border">
          git push --force origin main
        </pre>
      </ConfirmationContent>
      <ConfirmationPending>
        <ConfirmationAction>
          <ConfirmationReject className={rejectClass}>
            Cancel
          </ConfirmationReject>
          <ConfirmationAccept className={acceptClass}>
            Force push
          </ConfirmationAccept>
        </ConfirmationAction>
      </ConfirmationPending>
    </Confirmation>,
  );

export const Approved: Story = () =>
  surface(
    <Confirmation state="approved">
      <ConfirmationHeader>
        <ConfirmationIcon>
          <ShieldIcon />
        </ConfirmationIcon>
        <ConfirmationTitle>Run bash command?</ConfirmationTitle>
      </ConfirmationHeader>
      <CommandBody />
      <ConfirmationApproved>
        <ConfirmationStatus>
          <CheckIcon />
          Approved — running command
        </ConfirmationStatus>
      </ConfirmationApproved>
    </Confirmation>,
  );

export const Rejected: Story = () =>
  surface(
    <Confirmation state="rejected" tone="danger">
      <ConfirmationHeader>
        <ConfirmationIcon>
          <ShieldIcon />
        </ConfirmationIcon>
        <ConfirmationTitle>Force-push to main?</ConfirmationTitle>
      </ConfirmationHeader>
      <CommandBody />
      <ConfirmationRejected>
        <ConfirmationStatus>
          <XIcon />
          Denied by user
        </ConfirmationStatus>
      </ConfirmationRejected>
    </Confirmation>,
  );

export const Interactive: Story = () =>
  surface(
    <Confirmation defaultState="pending">
      <ConfirmationHeader>
        <ConfirmationIcon>
          <ShieldIcon />
        </ConfirmationIcon>
        <ConfirmationTitle>Edit src/server/db.ts?</ConfirmationTitle>
      </ConfirmationHeader>
      <ConfirmationDescription>
        Click Allow or Deny to flip the uncontrolled state.
      </ConfirmationDescription>
      <ConfirmationContent>
        <pre className="overflow-x-auto rounded bg-surface-elevated px-3 py-2 font-mono text-xs text-foreground ring ring-border">
          {`- const pool = new Pool({ max: 10 });\n+ const pool = new Pool({ max: 25 });`}
        </pre>
      </ConfirmationContent>
      <ConfirmationPending>
        <ConfirmationAction>
          <ConfirmationReject className={rejectClass}>Deny</ConfirmationReject>
          <ConfirmationAccept className={acceptClass}>Allow</ConfirmationAccept>
        </ConfirmationAction>
      </ConfirmationPending>
      <ConfirmationApproved>
        <ConfirmationStatus>
          <CheckIcon />
          Approved — applying edit
        </ConfirmationStatus>
      </ConfirmationApproved>
      <ConfirmationRejected>
        <ConfirmationStatus>
          <XIcon />
          Denied by user
        </ConfirmationStatus>
      </ConfirmationRejected>
    </Confirmation>,
  );

export const LongContent: Story = () =>
  surface(
    <Confirmation state="pending">
      <ConfirmationHeader>
        <ConfirmationIcon>
          <ShieldIcon />
        </ConfirmationIcon>
        <ConfirmationTitle>
          Run database migration against the production replica before promoting
          it to primary?
        </ConfirmationTitle>
      </ConfirmationHeader>
      <ConfirmationDescription>
        The agent generated a multi-statement migration. Review each statement
        before allowing execution.
      </ConfirmationDescription>
      <ConfirmationContent>
        <pre className="overflow-x-auto rounded bg-surface-elevated px-3 py-2 font-mono text-xs text-foreground ring ring-border">
          {`BEGIN;
ALTER TABLE threads ADD COLUMN resume_policy text NOT NULL DEFAULT 'server-authoritative';
ALTER TABLE threads ADD COLUMN last_run_liveness_checked_at timestamptz;
CREATE INDEX CONCURRENTLY idx_threads_resume_policy ON threads (resume_policy);
UPDATE threads SET resume_policy = 'legacy' WHERE created_at < now() - interval '90 days';
COMMIT;`}
        </pre>
      </ConfirmationContent>
      <ConfirmationPending>
        <ConfirmationAction>
          <ConfirmationReject className={rejectClass}>Deny</ConfirmationReject>
          <ConfirmationAccept className={acceptClass}>Allow</ConfirmationAccept>
        </ConfirmationAction>
      </ConfirmationPending>
    </Confirmation>,
  );

export default {
  title: "ai/confirmation",
} satisfies StoryDefault;
