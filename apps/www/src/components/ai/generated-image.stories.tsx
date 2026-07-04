import type { Story, StoryDefault } from "@ladle/react";
import {
  GeneratedImage,
  GeneratedImageAction,
  GeneratedImageError,
  GeneratedImageHeader,
  GeneratedImageLoading,
  GeneratedImageOverlay,
  GeneratedImagePlaceholder,
  GeneratedImageProgress,
  GeneratedImageTitle,
} from "./generated-image";

const Surface = ({ children }: { children: React.ReactNode }) => (
  <div className="nauval-chat-surface p-6 max-w-2xl">{children}</div>
);

const IMAGE_DATA_URI =
  "data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='512'%20height='512'%3E%3Cdefs%3E%3ClinearGradient%20id='s'%20x1='0'%20y1='0'%20x2='0'%20y2='1'%3E%3Cstop%20offset='0'%20stop-color='%23fca5a5'/%3E%3Cstop%20offset='0.55'%20stop-color='%23c084fc'/%3E%3Cstop%20offset='1'%20stop-color='%23312e81'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect%20width='512'%20height='512'%20fill='url(%23s)'/%3E%3Ccircle%20cx='372'%20cy='138'%20r='58'%20fill='%23fde68a'/%3E%3Cpath%20d='M0%20512%20132%20312%20250%20430%20372%20286%20512%20452%20512%20512Z'%20fill='%23134e4a'/%3E%3Cpath%20d='M0%20512%20210%20388%20330%20470%20470%20360%20512%20396%20512%20512Z'%20fill='%230f766e'/%3E%3C/svg%3E";

const iconButton =
  "inline-flex size-8 items-center justify-center rounded-md bg-black/25 backdrop-blur-sm transition-colors [&>svg]:size-4";

const DownloadIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M12 3v12m0 0 4-4m-4 4-4-4" strokeLinecap="round" />
    <path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2" strokeLinecap="round" />
  </svg>
);

const RefreshIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M3 12a9 9 0 0 1 15-6.7L21 8" strokeLinecap="round" />
    <path d="M21 3v5h-5" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M21 12a9 9 0 0 1-15 6.7L3 16" strokeLinecap="round" />
    <path d="M3 21v-5h5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const AlertIcon = () => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    className="size-6 text-destructive"
  >
    <path d="M12 9v4" strokeLinecap="round" />
    <path d="M12 17h.01" strokeLinecap="round" />
    <circle cx="12" cy="12" r="9" />
  </svg>
);

export const Complete: Story = () => (
  <Surface>
    <div className="max-w-sm">
      <GeneratedImage state="complete">
        <img
          data-slot="generated-image-content"
          src={IMAGE_DATA_URI}
          alt="A generated sunset over layered mountains"
        />
        <GeneratedImageOverlay position="bottom" />
        <GeneratedImageHeader className="top-auto bottom-4">
          <GeneratedImageTitle>Sunset over the ridgeline</GeneratedImageTitle>
        </GeneratedImageHeader>
        <GeneratedImageAction position="top-right">
          <button type="button" data-slot="button" className={iconButton}>
            <DownloadIcon />
          </button>
        </GeneratedImageAction>
      </GeneratedImage>
    </div>
  </Surface>
);

export const Generating: Story = () => (
  <Surface>
    <div className="max-w-sm">
      <GeneratedImage state="generating">
        <img
          data-slot="generated-image-content"
          src={IMAGE_DATA_URI}
          alt="A generated sunset over layered mountains"
        />
        <GeneratedImageLoading />
        <GeneratedImageHeader>
          <GeneratedImageTitle>Generating image…</GeneratedImageTitle>
        </GeneratedImageHeader>
        <GeneratedImageProgress>
          <div className="absolute bottom-4 left-5 z-10 text-xs text-white/80">
            Rendering · 62%
          </div>
        </GeneratedImageProgress>
      </GeneratedImage>
    </div>
  </Surface>
);

export const Queued: Story = () => (
  <Surface>
    <div className="max-w-sm">
      <GeneratedImage state="queued">
        <GeneratedImageLoading />
        <GeneratedImagePlaceholder>
          <div className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">
            Queued
          </div>
        </GeneratedImagePlaceholder>
      </GeneratedImage>
    </div>
  </Surface>
);

export const Errored: Story = () => (
  <Surface>
    <div className="max-w-sm">
      <GeneratedImage state="error">
        <img
          data-slot="generated-image-content"
          src={IMAGE_DATA_URI}
          alt="A generated sunset over layered mountains"
        />
        <GeneratedImageError>
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center">
            <AlertIcon />
            <p className="text-sm font-medium text-foreground">
              Generation failed
            </p>
            <p className="max-w-[16rem] text-xs text-muted-foreground">
              The model rejected the prompt for a safety policy violation.
            </p>
            <button
              type="button"
              className="mt-1 inline-flex items-center gap-1.5 rounded-md bg-surface-elevated px-3 py-1.5 text-xs text-foreground ring ring-border [&>svg]:size-3.5"
            >
              <RefreshIcon />
              Retry
            </button>
          </div>
        </GeneratedImageError>
      </GeneratedImage>
    </div>
  </Surface>
);

export const AspectRatioVideo: Story = () => (
  <Surface>
    <GeneratedImage state="complete" aspectRatio="video">
      <img
        data-slot="generated-image-content"
        src={IMAGE_DATA_URI}
        alt="A generated sunset over layered mountains"
      />
      <GeneratedImageOverlay position="top" />
      <GeneratedImageHeader>
        <GeneratedImageTitle>16 : 9 render</GeneratedImageTitle>
      </GeneratedImageHeader>
    </GeneratedImage>
  </Surface>
);

export const AspectRatioPortrait: Story = () => (
  <Surface>
    <div className="max-w-xs">
      <GeneratedImage state="complete" aspectRatio="portrait">
        <img
          data-slot="generated-image-content"
          src={IMAGE_DATA_URI}
          alt="A generated sunset over layered mountains"
        />
        <GeneratedImageOverlay position="both" />
        <GeneratedImageHeader>
          <GeneratedImageTitle>3 : 4 portrait</GeneratedImageTitle>
        </GeneratedImageHeader>
      </GeneratedImage>
    </div>
  </Surface>
);

export const AspectRatioAuto: Story = () => (
  <Surface>
    <GeneratedImage state="complete" aspectRatio="auto">
      <img
        data-slot="generated-image-content"
        src={IMAGE_DATA_URI}
        alt="A generated sunset over layered mountains"
        className="!static !size-auto !w-full"
      />
    </GeneratedImage>
  </Surface>
);

export const StateGallery: Story = () => (
  <Surface>
    <div className="grid grid-cols-2 gap-3">
      <GeneratedImage state="queued">
        <GeneratedImageLoading />
        <GeneratedImagePlaceholder>
          <div className="absolute inset-0 grid place-items-center text-xs text-muted-foreground">
            Queued
          </div>
        </GeneratedImagePlaceholder>
      </GeneratedImage>
      <GeneratedImage state="generating">
        <img
          data-slot="generated-image-content"
          src={IMAGE_DATA_URI}
          alt="Generating"
        />
        <GeneratedImageLoading />
        <GeneratedImageHeader>
          <GeneratedImageTitle>Generating…</GeneratedImageTitle>
        </GeneratedImageHeader>
      </GeneratedImage>
      <GeneratedImage state="complete">
        <img
          data-slot="generated-image-content"
          src={IMAGE_DATA_URI}
          alt="Complete"
        />
        <GeneratedImageOverlay position="bottom" />
      </GeneratedImage>
      <GeneratedImage state="error">
        <img
          data-slot="generated-image-content"
          src={IMAGE_DATA_URI}
          alt="Error"
        />
        <GeneratedImageError>
          <div className="absolute inset-0 grid place-items-center">
            <AlertIcon />
          </div>
        </GeneratedImageError>
      </GeneratedImage>
    </div>
  </Surface>
);

export default {
  title: "ai/generated-image",
} satisfies StoryDefault;
