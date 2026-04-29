import { describe, expect, it } from "vitest";
import { diffPartFromFileChangeResult } from "./file-change-tool";
import { FILE_CHANGE_DIFF_RESULT_TYPE } from "./tool-registry";

describe("diffPartFromFileChangeResult", () => {
  it("parses structured FileChange diff results", () => {
    const result = JSON.stringify({
      type: FILE_CHANGE_DIFF_RESULT_TYPE,
      part: {
        type: "diff",
        filePath: "src/button.tsx",
        oldContent: "old",
        newContent: "new",
        unifiedDiff:
          "--- a/src/button.tsx\n+++ b/src/button.tsx\n@@ -1 +1 @@\n-old\n+new",
        status: "applied",
      },
    });

    expect(diffPartFromFileChangeResult(result)).toEqual({
      type: "diff",
      filePath: "src/button.tsx",
      oldContent: "old",
      newContent: "new",
      unifiedDiff:
        "--- a/src/button.tsx\n+++ b/src/button.tsx\n@@ -1 +1 @@\n-old\n+new",
      status: "applied",
    });
  });

  it("ignores normal string tool output", () => {
    expect(diffPartFromFileChangeResult("Edited 1 file")).toBeNull();
  });
});
