import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { FilesChangedHeader } from "./git-diff-view";
import { TextFilePart } from "./text-file-part";

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
