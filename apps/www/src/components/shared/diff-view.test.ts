import { describe, expect, it } from "vitest";
import { createNoChangePatch } from "./diff-view";

describe("createNoChangePatch", () => {
  it("emits a unified patch with every line as unchanged context", () => {
    const patch = createNoChangePatch("src/foo.ts", "line one\nline two");
    expect(patch).toContain("diff --git a/src/foo.ts b/src/foo.ts");
    expect(patch).toContain("--- a/src/foo.ts");
    expect(patch).toContain("+++ b/src/foo.ts");
    expect(patch).toContain("@@ -1,2 +1,2 @@");
    expect(patch).toContain(" line one");
    expect(patch).toContain(" line two");
    expect(patch).not.toMatch(/^\+line one/m);
    expect(patch).not.toMatch(/^-line one/m);
  });

  it("counts a trailing newline as an extra (empty) line", () => {
    const patch = createNoChangePatch("a.txt", "only\n");
    expect(patch).toContain("@@ -1,2 +1,2 @@");
  });
});
