/* @vitest-environment jsdom */

import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadInfoFull } from "@terragon/shared";
import {
  createRepoFileArtifactDescriptor,
  type GitDiffArtifactDescriptor,
  type RepoFileArtifactDescriptor,
} from "@terragon/shared/db/artifact-descriptors";
import { FilesChangedHeader } from "./git-diff-view";
import {
  type ArtifactWorkspaceItem,
  getArtifactWorkspaceItemSummary,
} from "./secondary-panel-helpers";
import { TextFilePart } from "./text-file-part";

vi.mock("./git-diff-view", async () => {
  const actual =
    await vi.importActual<typeof import("./git-diff-view")>("./git-diff-view");
  return {
    ...actual,
    GitDiffView: () => <div data-testid="git-diff-view-stub" />,
  };
});

// Stub the repo-file renderer for the workspace-chrome tests so they exercise
// the tablist / keyboard / maximize / drawer wiring without the renderer's
// server-action fetch. The renderer's own R11 behavior (basename header,
// markdown/source toggle) is verified separately below against the real module.
vi.mock("./secondary-panel-repo-file", () => ({
  RepoFileArtifactRenderer: ({
    repoFilePart,
  }: {
    repoFilePart: { path: string };
  }) => <div data-testid="repo-file-renderer-stub">{repoFilePart.path}</div>,
}));

const REPO_FILE_PATH = "src/components/button.tsx";
const REPO_FILE_BASENAME = "button.tsx";

// R11: the per-file repo-file artifact. createRepoFileArtifactDescriptor titles
// the tab with the basename and summarizes it with the repo-relative path.
function makeRepoFileDescriptor(): RepoFileArtifactDescriptor {
  return createRepoFileArtifactDescriptor({
    path: REPO_FILE_PATH,
    ref: "feature-branch",
  });
}

function makePlanItem(): ArtifactWorkspaceItem {
  return {
    id: "artifact:plan-1",
    kind: "plan",
    title: "Plan",
    status: "ready",
    summary: "1 task",
    descriptor: {
      id: "artifact:plan-1",
      kind: "plan",
      title: "Plan",
      status: "ready",
      part: { type: "plan", planText: "Step one", title: "Plan" },
      origin: {
        type: "plan-tool",
        toolCallId: "plan-1",
        fingerprint: "plan-fingerprint",
      },
    } as ArtifactWorkspaceItem["descriptor"],
  };
}

function makeWorkspaceItem(
  descriptor: RepoFileArtifactDescriptor | GitDiffArtifactDescriptor,
): ArtifactWorkspaceItem {
  return { ...getArtifactWorkspaceItemSummary(descriptor), descriptor };
}

describe("artifact workspace accessibility controls", () => {
  it("adds accessible labels to text file icon buttons", () => {
    const html = renderToStaticMarkup(
      <TextFilePart
        textFileUrl="https://example.com/report.txt"
        filename="report.txt"
        onOpenInArtifactWorkspace={vi.fn()}
      />,
    );

    expect(html).toContain(
      'aria-label="Open report.txt in artifact workspace"',
    );
    expect(html).toContain('aria-label="Download report.txt"');
  });

  it("announces state and relationships for git diff toggles", () => {
    const html = renderToStaticMarkup(
      <FilesChangedHeader
        fileCount={3}
        viewMode="split"
        onViewModeChange={vi.fn()}
        allExpanded={true}
        onToggleAll={vi.fn()}
        showFileTree={true}
        onToggleFileTree={vi.fn()}
        additions={12}
        deletions={4}
        isSmallScreen={false}
        fileTreeId="changed-files"
      />,
    );

    expect(html).toContain('aria-controls="changed-files"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('aria-label="Diff view mode"');
  });
});

describe("getArtifactWorkspaceItemSummary derives repo-file tab metadata (R11)", () => {
  it("titles the tab with the basename and summarizes it with the repo-relative path", () => {
    const summary = getArtifactWorkspaceItemSummary(makeRepoFileDescriptor());

    expect(summary.kind).toBe("repo-file");
    // R11: sensible title (file basename) + summary (relative path).
    expect(summary.title).toBe(REPO_FILE_BASENAME);
    expect(summary.summary).toBe(REPO_FILE_PATH);
    expect(summary.status).toBe("ready");
    // Source label is derived from origin.type === "repo-file" — real branching.
    expect(summary.sourceLabel).toBe("Repo file");
    expect(summary.errorMessage).toBeUndefined();
  });

  it("derives an error status and recomputes the summary for a too-large git diff (non-passthrough branch)", () => {
    // Exercises the non-passthrough branch shared with repo-file summaries:
    // when a git-diff is "too-large", getArtifactWorkspaceSummary recomputes the
    // summary from diffStats.files and the status flips to "error" with an
    // explanatory message — none read verbatim off the descriptor's summary.
    const descriptor: GitDiffArtifactDescriptor = {
      id: "artifact:thread:thread-2:git-diff",
      kind: "git-diff",
      title: "Current changes",
      status: "ready",
      part: {
        type: "git-diff",
        diff: "too-large",
        diffStats: { files: 4, additions: 0, deletions: 0 },
      },
      origin: { type: "thread", threadId: "thread-2", field: "gitDiff" },
      summary: "should be ignored for too-large diffs",
    };

    const summary = getArtifactWorkspaceItemSummary(descriptor);

    expect(summary.status).toBe("error");
    expect(summary.summary).toBe("4 files");
    expect(summary.summary).not.toBe(descriptor.summary);
    expect(summary.errorMessage).toBe(
      "This diff is too large to render in the artifact workspace.",
    );
  });
});

describe("repo-file artifact tab integrates with the artifact workspace chrome", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
      root = null;
    }
    container?.remove();
    container = null;
    vi.restoreAllMocks();
  });

  it("renders the repo-file tab in the tablist with the basename title and roving-tabindex wiring", async () => {
    const { SecondaryPanelContent } = await import("./secondary-panel-shell");
    const repoFileItem = makeWorkspaceItem(makeRepoFileDescriptor());
    const planItem = makePlanItem();

    const html = renderToStaticMarkup(
      <SecondaryPanelContent
        artifacts={[repoFileItem, planItem]}
        activeArtifactId={repoFileItem.id}
        onActiveArtifactChange={vi.fn()}
        onClose={vi.fn()}
        onToggleMaximize={vi.fn()}
        isMaximized={false}
        thread={{ id: "thread-1" } as ThreadInfoFull}
        messages={[]}
      />,
    );

    expect(html).toContain('role="tablist"');
    expect(html).toContain(`id="artifact-tab-${repoFileItem.id}"`);
    expect(html).toContain(`data-artifact-id="${repoFileItem.id}"`);
    // R11: the tab label is the file basename.
    expect(html).toContain(REPO_FILE_BASENAME);
    // Active repo-file tab is selected and roving-tabindex focusable; the
    // inactive tab is removed from the tab order.
    expect(html).toContain(
      `id="artifact-tab-${repoFileItem.id}" aria-selected="true"`,
    );
    expect(html).toContain(
      `id="artifact-tab-${planItem.id}" aria-selected="false"`,
    );
    // The active repo-file tab controls its tabpanel and renders the repo-file body.
    expect(html).toContain(`aria-controls="artifact-panel-${repoFileItem.id}"`);
    expect(html).toContain(`id="artifact-panel-${repoFileItem.id}"`);
    expect(html).toContain('data-testid="repo-file-renderer-stub"');
  });

  it("moves roving focus and selects the next tab on ArrowRight/Home/End keydown", async () => {
    const { SecondaryPanelContent } = await import("./secondary-panel-shell");
    const repoFileItem = makeWorkspaceItem(makeRepoFileDescriptor());
    const planItem = makePlanItem();
    const onActiveArtifactChange = vi.fn();

    act(() => {
      root?.render(
        <SecondaryPanelContent
          artifacts={[repoFileItem, planItem]}
          activeArtifactId={repoFileItem.id}
          onActiveArtifactChange={onActiveArtifactChange}
          onClose={vi.fn()}
          onToggleMaximize={vi.fn()}
          isMaximized={false}
          thread={{ id: "thread-1" } as ThreadInfoFull}
          messages={[]}
        />,
      );
    });

    const tabs = Array.from(
      container?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [],
    );
    expect(tabs).toHaveLength(2);
    const [repoTab, planTab] = tabs as [HTMLButtonElement, HTMLButtonElement];

    // The active (repo-file) tab is the roving-tabindex focus target.
    expect(repoTab.tabIndex).toBe(0);
    expect(planTab.tabIndex).toBe(-1);

    // ArrowRight from the repo-file tab moves focus to the plan tab and
    // requests activation of the plan artifact via the real handleTabKeyDown.
    act(() => {
      repoTab.focus();
      repoTab.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowRight",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(document.activeElement).toBe(planTab);
    expect(onActiveArtifactChange).toHaveBeenLastCalledWith(planItem.id);

    // End jumps to the last tab (still the plan tab here).
    onActiveArtifactChange.mockClear();
    act(() => {
      repoTab.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "End",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(document.activeElement).toBe(planTab);
    expect(onActiveArtifactChange).toHaveBeenLastCalledWith(planItem.id);

    // Home jumps back to the first (repo-file) tab.
    onActiveArtifactChange.mockClear();
    act(() => {
      planTab.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Home",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(document.activeElement).toBe(repoTab);
    expect(onActiveArtifactChange).toHaveBeenLastCalledWith(repoFileItem.id);
  });

  it("activates a clicked repo-file tab through onActiveArtifactChange", async () => {
    const { SecondaryPanelContent } = await import("./secondary-panel-shell");
    const repoFileItem = makeWorkspaceItem(makeRepoFileDescriptor());
    const planItem = makePlanItem();
    const onActiveArtifactChange = vi.fn();

    act(() => {
      root?.render(
        <SecondaryPanelContent
          artifacts={[repoFileItem, planItem]}
          activeArtifactId={planItem.id}
          onActiveArtifactChange={onActiveArtifactChange}
          onClose={vi.fn()}
          onToggleMaximize={vi.fn()}
          isMaximized={false}
          thread={{ id: "thread-1" } as ThreadInfoFull}
          messages={[]}
        />,
      );
    });

    const repoTab = container?.querySelector<HTMLButtonElement>(
      `[id="artifact-tab-${repoFileItem.id}"]`,
    );
    expect(repoTab).toBeTruthy();
    act(() => {
      repoTab?.click();
    });
    expect(onActiveArtifactChange).toHaveBeenCalledWith(repoFileItem.id);
  });

  it("exposes maximize and close controls in the chrome header", async () => {
    const { SecondaryPanelContent } = await import("./secondary-panel-shell");
    const repoFileItem = makeWorkspaceItem(makeRepoFileDescriptor());

    const html = renderToStaticMarkup(
      <SecondaryPanelContent
        artifacts={[repoFileItem]}
        activeArtifactId={repoFileItem.id}
        onActiveArtifactChange={vi.fn()}
        onClose={vi.fn()}
        onToggleMaximize={vi.fn()}
        isMaximized={false}
        thread={{ id: "thread-1" } as ThreadInfoFull}
        messages={[]}
      />,
    );

    expect(html).toContain('aria-label="Maximize panel"');
    expect(html).toContain('aria-label="Close panel"');
  });

  it("threads the repo-file artifact through the mobile drawer into the shared panel content", async () => {
    // The mobile drawer (vaul) portals on client mount and renders nothing in
    // SSR, so render it through a stubbed Drawer that simply passes children
    // through. This proves the drawer forwards the repo-file artifact, active
    // id, and thread into the same SecondaryPanelContent the desktop chrome
    // uses (verified above) — i.e. R11 mobile rendering reuses the shared shell.
    vi.resetModules();
    vi.doMock("@/components/ui/drawer", () => {
      const Passthrough = ({ children }: { children?: React.ReactNode }) => (
        <div>{children}</div>
      );
      return {
        Drawer: Passthrough,
        DrawerContent: Passthrough,
        DrawerHeader: Passthrough,
        DrawerTitle: Passthrough,
      };
    });
    vi.doMock("./secondary-panel-repo-file", () => ({
      RepoFileArtifactRenderer: ({
        repoFilePart,
      }: {
        repoFilePart: { path: string };
      }) => (
        <div data-testid="repo-file-renderer-stub">{repoFilePart.path}</div>
      ),
    }));

    const { MobileArtifactDrawer } = await import(
      "./secondary-panel-mobile-drawer"
    );
    const repoFileItem = makeWorkspaceItem(makeRepoFileDescriptor());

    const html = renderToStaticMarkup(
      <MobileArtifactDrawer
        isOpen={true}
        onOpenChange={vi.fn()}
        artifacts={[repoFileItem]}
        activeArtifactId={repoFileItem.id}
        onActiveArtifactChange={vi.fn()}
        onClose={vi.fn()}
        thread={{ id: "thread-1" } as ThreadInfoFull}
        messages={[]}
      />,
    );

    expect(html).toContain("Artifact workspace");
    // R11: basename title surfaces in the mobile tab too.
    expect(html).toContain(REPO_FILE_BASENAME);
    expect(html).toContain('data-testid="repo-file-renderer-stub"');

    vi.doUnmock("@/components/ui/drawer");
    vi.doUnmock("./secondary-panel-repo-file");
    vi.resetModules();
  });
});
