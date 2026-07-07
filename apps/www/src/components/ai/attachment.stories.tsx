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

const DownloadIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M12 3v12m0 0 4-4m-4 4-4-4" strokeLinecap="round" />
    <path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2" strokeLinecap="round" />
  </svg>
);

const EyeIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

const CheckIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="m5 13 4 4 10-10" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const IMAGE_DATA_URI =
  "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='64'%20height='64'%3E%3Crect%20width='64'%20height='64'%20fill='%234f46e5'/%3E%3Ccircle%20cx='44'%20cy='18'%20r='9'%20fill='%23fbbf24'/%3E%3Cpath%20d='M0%2064%2022%2036%2040%2056%2064%2038%2064%2064Z'%20fill='%2322c55e'/%3E%3C/svg%3E";

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

export const CardImageThumbnail: Story = () =>
  surface(
    <Attachment layout="card">
      <AttachmentMedia>
        <img
          data-slot="attachment-media-img"
          src={IMAGE_DATA_URI}
          alt="Screenshot of the failing test output"
        />
      </AttachmentMedia>
    </Attachment>,
  );

export const RowInteractiveButton: Story = () =>
  surface(
    <Attachment layout="row" render={<button type="button" />}>
      <AttachmentMedia>
        <AttachmentIcon>
          <FileIcon />
        </AttachmentIcon>
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentName>route.test.ts</AttachmentName>
        <AttachmentDescription>Click to open · 24 KB</AttachmentDescription>
      </AttachmentContent>
    </Attachment>,
  );

export const CardInteractiveLink: Story = () =>
  surface(
    <Attachment
      layout="card"
      render={<a href="#preview" aria-label="Open screenshot" />}
    >
      <AttachmentMedia>
        <img
          data-slot="attachment-media-img"
          src={IMAGE_DATA_URI}
          alt="Screenshot of the failing test output"
        />
      </AttachmentMedia>
    </Attachment>,
  );

export const CardWithDismiss: Story = () =>
  surface(
    <Attachment layout="card">
      <AttachmentMedia>
        <img
          data-slot="attachment-media-img"
          src={IMAGE_DATA_URI}
          alt="Screenshot of the failing test output"
        />
      </AttachmentMedia>
      <button
        type="button"
        aria-label="Remove"
        className="absolute -right-1.5 -top-1.5 inline-flex size-5 items-center justify-center rounded-full bg-foreground text-background shadow-sm hover:bg-foreground/90 [&>svg]:size-3"
      >
        <RemoveIcon />
      </button>
    </Attachment>,
  );

export const RowUploadSuccess: Story = () =>
  surface(
    <Attachment layout="row">
      <AttachmentMedia className="bg-success/15 text-success">
        <AttachmentIcon>
          <CheckIcon />
        </AttachmentIcon>
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentName>diagram.png</AttachmentName>
        <AttachmentDescription className="text-success">
          Uploaded · 512 KB
        </AttachmentDescription>
      </AttachmentContent>
      <AttachmentAction>
        <span className="inline-flex size-6 items-center justify-center rounded text-success [&>svg]:size-4">
          <CheckIcon />
        </span>
      </AttachmentAction>
    </Attachment>,
  );

export const CardUploadSuccess: Story = () =>
  surface(
    <Attachment layout="card">
      <AttachmentMedia>
        <img
          data-slot="attachment-media-img"
          src={IMAGE_DATA_URI}
          alt="Screenshot of the failing test output"
        />
        <AttachmentOverlay className="bg-success/25 text-success backdrop-blur-none [&>svg]:size-6">
          <CheckIcon />
        </AttachmentOverlay>
      </AttachmentMedia>
    </Attachment>,
  );

export const RowMultipleActions: Story = () =>
  surface(
    <Attachment layout="row">
      <AttachmentMedia>
        <AttachmentIcon>
          <ImageIcon />
        </AttachmentIcon>
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentName>architecture-diagram.png</AttachmentName>
        <AttachmentDescription>PNG · 512 KB</AttachmentDescription>
      </AttachmentContent>
      <AttachmentAction>
        <button type="button" className={removeClass} aria-label="Preview">
          <EyeIcon />
        </button>
        <button type="button" className={removeClass} aria-label="Download">
          <DownloadIcon />
        </button>
        <button type="button" className={removeClass} aria-label="Remove">
          <RemoveIcon />
        </button>
      </AttachmentAction>
    </Attachment>,
  );

export default {
  title: "ai/attachment",
} satisfies StoryDefault;
