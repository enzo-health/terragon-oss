import type { Story, StoryDefault } from "@ladle/react";
import {
  Uploader,
  UploaderDropzone,
  UploaderList,
  UploaderTrigger,
  type UploadItem,
  type UploaderFn,
} from "./uploader";

const Surface = ({ children }: { children: React.ReactNode }) => (
  <div className="nauval-chat-surface p-6 max-w-2xl">{children}</div>
);

const noopUploader: UploaderFn = () => new Promise(() => {});

const IMAGE_DATA_URI =
  "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='64'%20height='64'%3E%3Crect%20width='64'%20height='64'%20fill='%234f46e5'/%3E%3Ccircle%20cx='44'%20cy='18'%20r='9'%20fill='%23fbbf24'/%3E%3Cpath%20d='M0%2064%2022%2036%2040%2056%2064%2038%2064%2064Z'%20fill='%2322c55e'/%3E%3C/svg%3E";

const UploadIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M12 16V4m0 0 4 4m-4-4-4 4" strokeLinecap="round" />
    <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" strokeLinecap="round" />
  </svg>
);

const FileIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path
      d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"
      strokeLinejoin="round"
    />
    <path d="M14 2v6h6" strokeLinejoin="round" />
  </svg>
);

const RemoveIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M6 6 18 18M18 6 6 18" strokeLinecap="round" />
  </svg>
);

const RetryIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M3 12a9 9 0 0 1 15-6.7L21 8" strokeLinecap="round" />
    <path d="M21 3v5h-5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const CheckIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="m5 13 4 4 10-10" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const iconButton =
  "inline-flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-muted [&>svg]:size-3.5";

function formatBytes(bytes?: number) {
  if (bytes === undefined) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function UploadRow({
  item,
  actions,
}: {
  item: UploadItem & { preview?: string };
  actions: { cancel: () => void; retry: () => void; remove: () => void };
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-surface px-3 py-2">
      <div className="grid size-9 shrink-0 place-items-center overflow-hidden rounded bg-surface-elevated text-muted-foreground [&>svg]:size-4">
        {item.preview ? (
          <img
            src={item.preview}
            alt={item.name}
            className="size-full object-cover"
          />
        ) : (
          <FileIcon />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-foreground">{item.name}</p>
        {item.status === "error" ? (
          <p className="truncate text-xs text-destructive">
            {item.error?.message ?? "Upload failed"}
          </p>
        ) : item.status === "uploading" ? (
          <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-[width]"
              style={{ width: `${item.progress}%` }}
            />
          </div>
        ) : (
          <p className="truncate text-xs text-muted-foreground">
            {item.status === "success"
              ? `Uploaded · ${formatBytes(item.size)}`
              : item.status === "canceled"
                ? "Canceled"
                : formatBytes(item.size)}
          </p>
        )}
      </div>
      {item.status === "success" ? (
        <span className="inline-flex size-7 items-center justify-center rounded text-success [&>svg]:size-4">
          <CheckIcon />
        </span>
      ) : item.status === "error" || item.status === "canceled" ? (
        <button
          type="button"
          className={iconButton}
          aria-label="Retry"
          onClick={actions.retry}
        >
          <RetryIcon />
        </button>
      ) : null}
      <button
        type="button"
        className={iconButton}
        aria-label="Remove"
        onClick={item.status === "uploading" ? actions.cancel : actions.remove}
      >
        <RemoveIcon />
      </button>
    </div>
  );
}

const dropzoneClass =
  "flex flex-col items-center justify-center gap-2 rounded-outer border-2 border-dashed border-border px-6 py-10 text-center text-muted-foreground transition-colors data-[drag-over]:border-primary data-[drag-over]:bg-primary/5 [&>svg]:size-6";

export const Empty: Story = () => (
  <Surface>
    <div className="max-w-md">
      <Uploader uploader={noopUploader} autoUpload={false} items={[]}>
        <UploaderDropzone className={dropzoneClass}>
          <UploadIcon />
          <p className="text-sm text-foreground">Drop files to attach</p>
          <p className="text-xs">PNG, PDF or TXT up to 10 MB</p>
          <UploaderTrigger className="mt-1 inline-flex items-center gap-1.5 rounded-md bg-surface-elevated px-3 py-1.5 text-xs text-foreground ring ring-border">
            Browse files
          </UploaderTrigger>
        </UploaderDropzone>
      </Uploader>
    </div>
  </Surface>
);

export const Uploading: Story = () => {
  const items: UploadItem[] = [
    {
      id: "1",
      name: "architecture-diagram.png",
      size: 524288,
      type: "image/png",
      status: "uploading",
      progress: 42,
      previewUrl: IMAGE_DATA_URI,
    },
    {
      id: "2",
      name: "route.test.ts",
      size: 24576,
      type: "text/plain",
      status: "uploading",
      progress: 88,
    },
  ];
  return (
    <Surface>
      <div className="max-w-md">
        <Uploader uploader={noopUploader} autoUpload={false} items={items}>
          <UploaderList className="flex flex-col gap-2">
            {(item, actions) => <UploadRow item={item} actions={actions} />}
          </UploaderList>
        </Uploader>
      </div>
    </Surface>
  );
};

export const Mixed: Story = () => {
  const items: UploadItem[] = [
    {
      id: "1",
      name: "diagram.png",
      size: 524288,
      type: "image/png",
      status: "success",
      progress: 100,
      previewUrl: IMAGE_DATA_URI,
    },
    {
      id: "2",
      name: "notes.md",
      size: 4096,
      type: "text/markdown",
      status: "uploading",
      progress: 63,
    },
    {
      id: "3",
      name: "sandbox-image.tar",
      size: 734003200,
      type: "application/x-tar",
      status: "error",
      progress: 0,
      error: { code: "max_size", message: "File exceeds the 10 MB limit" },
    },
    {
      id: "4",
      name: "draft.pdf",
      size: 102400,
      type: "application/pdf",
      status: "canceled",
      progress: 0,
    },
  ];
  return (
    <Surface>
      <div className="max-w-md">
        <Uploader uploader={noopUploader} autoUpload={false} items={items}>
          <UploaderList className="flex flex-col gap-2">
            {(item, actions) => <UploadRow item={item} actions={actions} />}
          </UploaderList>
        </Uploader>
      </div>
    </Surface>
  );
};

export const AllSucceeded: Story = () => {
  const items: UploadItem[] = [
    {
      id: "1",
      name: "diagram.png",
      size: 524288,
      type: "image/png",
      status: "success",
      progress: 100,
      previewUrl: IMAGE_DATA_URI,
    },
    {
      id: "2",
      name: "route.test.ts",
      size: 24576,
      type: "text/plain",
      status: "success",
      progress: 100,
    },
  ];
  return (
    <Surface>
      <div className="max-w-md">
        <Uploader uploader={noopUploader} autoUpload={false} items={items}>
          <UploaderList className="flex flex-col gap-2">
            {(item, actions) => <UploadRow item={item} actions={actions} />}
          </UploaderList>
        </Uploader>
      </div>
    </Surface>
  );
};

export const Errored: Story = () => {
  const items: UploadItem[] = [
    {
      id: "1",
      name: "sandbox-image.tar",
      size: 734003200,
      type: "application/x-tar",
      status: "error",
      progress: 0,
      error: { code: "max_size", message: "File exceeds the 10 MB limit" },
    },
    {
      id: "2",
      name: "screenshot.heic",
      size: 2097152,
      type: "image/heic",
      status: "error",
      progress: 0,
      error: { code: "accept", message: "File type not accepted" },
    },
  ];
  return (
    <Surface>
      <div className="max-w-md">
        <Uploader uploader={noopUploader} autoUpload={false} items={items}>
          <UploaderList className="flex flex-col gap-2">
            {(item, actions) => <UploadRow item={item} actions={actions} />}
          </UploaderList>
        </Uploader>
      </div>
    </Surface>
  );
};

export const DropzoneWithList: Story = () => {
  const items: UploadItem[] = [
    {
      id: "1",
      name: "diagram.png",
      size: 524288,
      type: "image/png",
      status: "success",
      progress: 100,
      previewUrl: IMAGE_DATA_URI,
    },
    {
      id: "2",
      name: "notes.md",
      size: 4096,
      type: "text/markdown",
      status: "uploading",
      progress: 30,
    },
  ];
  return (
    <Surface>
      <div className="max-w-md">
        <Uploader uploader={noopUploader} autoUpload={false} items={items}>
          <UploaderDropzone className={`${dropzoneClass} mb-3`}>
            <UploadIcon />
            <p className="text-sm text-foreground">Drop more files here</p>
            <UploaderTrigger className="mt-1 inline-flex items-center gap-1.5 rounded-md bg-surface-elevated px-3 py-1.5 text-xs text-foreground ring ring-border">
              Browse
            </UploaderTrigger>
          </UploaderDropzone>
          <UploaderList className="flex flex-col gap-2">
            {(item, actions) => <UploadRow item={item} actions={actions} />}
          </UploaderList>
        </Uploader>
      </div>
    </Surface>
  );
};

export default {
  title: "ai/uploader",
} satisfies StoryDefault;
