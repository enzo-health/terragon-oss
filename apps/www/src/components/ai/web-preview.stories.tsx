import type { Story, StoryDefault } from "@ladle/react";
import {
  WebPreview,
  WebPreviewAddress,
  WebPreviewContent,
  WebPreviewHeader,
  WebPreviewOpen,
  WebPreviewPanel,
  WebPreviewPanelTrigger,
  WebPreviewPanels,
  WebPreviewReload,
} from "./web-preview";

const Surface = ({ children }: { children: React.ReactNode }) => (
  <div className="nauval-chat-surface p-6 max-w-2xl">{children}</div>
);

const PAGE_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  :root{color-scheme:dark}
  body{margin:0;font-family:ui-sans-serif,system-ui;background:#0b1220;color:#e5e7eb;display:grid;place-items:center;height:100vh}
  .card{text-align:center;padding:2rem}
  h1{margin:0 0 .5rem;font-size:1.5rem}
  p{margin:0;color:#94a3b8}
  .dot{display:inline-block;width:.6rem;height:.6rem;border-radius:9999px;background:#22c55e;margin-right:.4rem}
</style></head><body><div class="card"><h1><span class="dot"></span>Preview server</h1><p>localhost:3000 rendered in the iframe</p></div></body></html>`;

const PAGE_URL = `data:text/html,${encodeURIComponent(PAGE_HTML)}`;

const ReloadIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M3 12a9 9 0 0 1 15-6.7L21 8" strokeLinecap="round" />
    <path d="M21 3v5h-5" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M21 12a9 9 0 0 1-15 6.7L3 16" strokeLinecap="round" />
    <path d="M3 21v-5h5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const ExternalIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M14 4h6v6" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M20 4 10 14" strokeLinecap="round" />
    <path
      d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"
      strokeLinecap="round"
    />
  </svg>
);

const TerminalIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="m5 8 4 4-4 4" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M13 16h6" strokeLinecap="round" />
  </svg>
);

const chromeButton =
  "inline-flex size-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-surface-elevated disabled:opacity-40 disabled:pointer-events-none [&>svg]:size-4";

export const WithPage: Story = () => (
  <Surface>
    <WebPreview defaultUrl={PAGE_URL}>
      <WebPreviewHeader>
        <WebPreviewReload className={chromeButton}>
          <ReloadIcon />
        </WebPreviewReload>
        <WebPreviewAddress className="flex-1" />
        <WebPreviewOpen className={chromeButton}>
          <ExternalIcon />
        </WebPreviewOpen>
      </WebPreviewHeader>
      <WebPreviewContent />
    </WebPreview>
  </Surface>
);

export const Empty: Story = () => (
  <Surface>
    <WebPreview>
      <WebPreviewHeader>
        <WebPreviewReload className={chromeButton}>
          <ReloadIcon />
        </WebPreviewReload>
        <WebPreviewAddress className="flex-1" />
        <WebPreviewOpen className={chromeButton}>
          <ExternalIcon />
        </WebPreviewOpen>
      </WebPreviewHeader>
      <WebPreviewContent />
    </WebPreview>
  </Surface>
);

export const ConstrainedViewport: Story = () => (
  <Surface>
    <WebPreview defaultUrl={PAGE_URL} defaultViewport={390}>
      <WebPreviewHeader>
        <WebPreviewReload className={chromeButton}>
          <ReloadIcon />
        </WebPreviewReload>
        <WebPreviewAddress className="flex-1" />
        <WebPreviewOpen className={chromeButton}>
          <ExternalIcon />
        </WebPreviewOpen>
      </WebPreviewHeader>
      <WebPreviewContent />
    </WebPreview>
  </Surface>
);

export const WithConsolePanel: Story = () => (
  <Surface>
    <WebPreview defaultUrl={PAGE_URL} defaultPanel="console">
      <WebPreviewHeader>
        <WebPreviewReload className={chromeButton}>
          <ReloadIcon />
        </WebPreviewReload>
        <WebPreviewAddress className="flex-1" />
        <WebPreviewPanelTrigger
          panelId="console"
          className={`${chromeButton} data-[active]:bg-surface-elevated data-[active]:text-foreground`}
        >
          <TerminalIcon />
        </WebPreviewPanelTrigger>
        <WebPreviewOpen className={chromeButton}>
          <ExternalIcon />
        </WebPreviewOpen>
      </WebPreviewHeader>
      <WebPreviewContent />
      <WebPreviewPanels>
        <WebPreviewPanel
          id="console"
          className="border-t border-border p-3 font-mono text-xs"
        >
          <p className="text-muted-foreground">[hmr] connected</p>
          <p className="text-muted-foreground">GET /api/ag-ui/thread-42 200</p>
          <p className="text-destructive">
            Warning: validateDOMNesting(...) &lt;div&gt; cannot appear as child
            of &lt;p&gt;
          </p>
        </WebPreviewPanel>
      </WebPreviewPanels>
    </WebPreview>
  </Surface>
);

export const AboutBlank: Story = () => (
  <Surface>
    <WebPreview defaultUrl="about:blank">
      <WebPreviewHeader>
        <WebPreviewReload className={chromeButton}>
          <ReloadIcon />
        </WebPreviewReload>
        <WebPreviewAddress className="flex-1" />
        <WebPreviewOpen className={chromeButton}>
          <ExternalIcon />
        </WebPreviewOpen>
      </WebPreviewHeader>
      <WebPreviewContent />
    </WebPreview>
  </Surface>
);

export default {
  title: "ai/web-preview",
} satisfies StoryDefault;
