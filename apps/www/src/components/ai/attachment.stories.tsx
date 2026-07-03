import type { Story, StoryDefault } from "@ladle/react";
import {
  Attachment,
  AttachmentAction,
  AttachmentContent,
  AttachmentDescription,
  AttachmentIcon,
  AttachmentMedia,
  AttachmentName,
  AttachmentOverlay,
  AttachmentProgress,
} from "./attachment";

const FileIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path
      d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"
      strokeLinejoin="round"
    />
    <path d="M14 2v6h6" strokeLinejoin="round" />
  </svg>
);

const ImageIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <circle cx="9" cy="9" r="1.5" />
    <path d="m21 15-5-5L5 21" strokeLinejoin="round" />
  </svg>
);

const RemoveIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M6 6 18 18M18 6 6 18" strokeLinecap="round" />
  </svg>
);

const removeClass =
  "inline-flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-muted [&>svg]:size-3.5";

const surface = (children: React.ReactNode) => (
  <div className="nauval-chat-surface p-6 max-w-2xl">{children}</div>
);

export const RowDefault: Story = () =>
  surface(
    <Attachment layout="row">
      <AttachmentMedia>
        <AttachmentIcon>
          <FileIcon />
        </AttachmentIcon>
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentName>route.test.ts</AttachmentName>
        <AttachmentDescription>TypeScript · 24 KB</AttachmentDescription>
      </AttachmentContent>
      <AttachmentAction>
        <button type="button" className={removeClass} aria-label="Remove">
          <RemoveIcon />
        </button>
      </AttachmentAction>
    </Attachment>,
  );

export const RowError: Story = () =>
  surface(
    <Attachment layout="row" state="error">
      <AttachmentMedia>
        <AttachmentIcon>
          <FileIcon />
        </AttachmentIcon>
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentName>sandbox-image.tar</AttachmentName>
        <AttachmentDescription>Upload failed · too large</AttachmentDescription>
      </AttachmentContent>
      <AttachmentAction>
        <button type="button" className={removeClass} aria-label="Remove">
          <RemoveIcon />
        </button>
      </AttachmentAction>
    </Attachment>,
  );

export const RowTruncatedName: Story = () =>
  surface(
    <div className="max-w-xs">
      <Attachment layout="row" className="w-full">
        <AttachmentMedia>
          <AttachmentIcon>
            <FileIcon />
          </AttachmentIcon>
        </AttachmentMedia>
        <AttachmentContent>
          <AttachmentName>
            2026-07-01-agent-architecture-redesign-final-notes-and-appendix.md
          </AttachmentName>
          <AttachmentDescription>
            docs/plans · Markdown · 112 KB
          </AttachmentDescription>
        </AttachmentContent>
      </Attachment>
    </div>,
  );

export const CardDefault: Story = () =>
  surface(
    <Attachment layout="card">
      <AttachmentMedia>
        <AttachmentIcon>
          <ImageIcon />
        </AttachmentIcon>
      </AttachmentMedia>
    </Attachment>,
  );

export const CardError: Story = () =>
  surface(
    <Attachment layout="card" state="error">
      <AttachmentMedia>
        <AttachmentIcon>
          <ImageIcon />
        </AttachmentIcon>
      </AttachmentMedia>
    </Attachment>,
  );

export const CardUploadingIndeterminate: Story = () =>
  surface(
    <Attachment layout="card">
      <AttachmentMedia>
        <AttachmentIcon>
          <ImageIcon />
        </AttachmentIcon>
        <AttachmentOverlay>
          <AttachmentProgress />
        </AttachmentOverlay>
      </AttachmentMedia>
    </Attachment>,
  );

export const CardUploadingDeterminate: Story = () =>
  surface(
    <Attachment layout="card" progress={68}>
      <AttachmentMedia>
        <AttachmentIcon>
          <ImageIcon />
        </AttachmentIcon>
        <AttachmentOverlay>
          <AttachmentProgress />
        </AttachmentOverlay>
      </AttachmentMedia>
    </Attachment>,
  );

export const CardGallery: Story = () =>
  surface(
    <div className="flex flex-wrap gap-2">
      <Attachment layout="card">
        <AttachmentMedia>
          <AttachmentIcon>
            <ImageIcon />
          </AttachmentIcon>
        </AttachmentMedia>
      </Attachment>
      <Attachment layout="card" progress={40}>
        <AttachmentMedia>
          <AttachmentIcon>
            <ImageIcon />
          </AttachmentIcon>
          <AttachmentOverlay>
            <AttachmentProgress />
          </AttachmentOverlay>
        </AttachmentMedia>
      </Attachment>
      <Attachment layout="card">
        <AttachmentMedia>
          <AttachmentIcon>
            <ImageIcon />
          </AttachmentIcon>
          <AttachmentOverlay>
            <AttachmentProgress />
          </AttachmentOverlay>
        </AttachmentMedia>
      </Attachment>
      <Attachment layout="card" state="error">
        <AttachmentMedia>
          <AttachmentIcon>
            <ImageIcon />
          </AttachmentIcon>
        </AttachmentMedia>
      </Attachment>
    </div>,
  );

export default {
  title: "ai/attachment",
} satisfies StoryDefault;
