import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkingMessage } from "./working-message";
import { createInitialThreadMetaSnapshot } from "../../thread-view-model/snapshot-adapter";

const metaSnapshot = createInitialThreadMetaSnapshot();

describe("WorkingMessage passive-wait rendering", () => {
  it("renders the passive-wait message without the 'esc to interrupt' hint", () => {
    const html = renderToStaticMarkup(
      <WorkingMessage
        agent="claudeCode"
        status="working"
        metaSnapshot={metaSnapshot}
        reattemptQueueAt={null}
        passiveWait={{ message: "Waiting for PR merge" }}
      />,
    );
    expect(html).toContain("Waiting for PR merge");
    expect(html).not.toContain("esc to interrupt");
    expect(html).not.toContain("Assistant is working");
    // Passive footer should not render the animated loader indicator.
    expect(html).not.toContain('data-slot="loader"');
  });

  it("falls through to the default 'Assistant is working' footer when passiveWait is null", () => {
    const html = renderToStaticMarkup(
      <WorkingMessage
        agent="claudeCode"
        status="working"
        metaSnapshot={metaSnapshot}
        reattemptQueueAt={null}
      />,
    );
    expect(html).toContain("Assistant is working");
    expect(html).toContain('data-slot="loader"');
  });

  it("renders the blocked reason as secondary text when provided", () => {
    const html = renderToStaticMarkup(
      <WorkingMessage
        agent="claudeCode"
        status="working"
        metaSnapshot={metaSnapshot}
        reattemptQueueAt={null}
        passiveWait={{
          message: "Waiting for your input",
          reason: "CI gate did not complete within polling budget",
        }}
      />,
    );
    expect(html).toContain("Waiting for your input");
    expect(html).toContain("CI gate did not complete within polling budget");
  });

  it("omits the secondary reason line when reason is null", () => {
    const html = renderToStaticMarkup(
      <WorkingMessage
        agent="claudeCode"
        status="working"
        metaSnapshot={metaSnapshot}
        reattemptQueueAt={null}
        passiveWait={{ message: "Waiting for your input", reason: null }}
      />,
    );
    expect(html).toContain("Waiting for your input");
    // When reason is null, no secondary span with the muted-xs class should
    // render — the generic line is the only content.
    expect(html).not.toContain("text-muted-foreground/60");
  });
});
