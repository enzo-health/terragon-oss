import { describe, it, expect } from "vitest";
import { classifyRepoFileLink, isMarkdownFile } from "./repo-file-link";

describe("classifyRepoFileLink", () => {
  describe("accepts in-repo paths", () => {
    it("repo-relative path", () => {
      expect(classifyRepoFileLink("src/foo.ts")).toEqual({
        path: "src/foo.ts",
      });
    });

    it("leading ./ is stripped", () => {
      expect(classifyRepoFileLink("./foo.ts")).toEqual({ path: "foo.ts" });
    });

    it("workspace-root-absolute path is normalized to relative", () => {
      expect(classifyRepoFileLink("/src/foo.ts")).toEqual({
        path: "src/foo.ts",
      });
    });

    it("collapses redundant slashes and . segments", () => {
      expect(classifyRepoFileLink("src/./bar//baz.ts")).toEqual({
        path: "src/bar/baz.ts",
      });
    });
  });

  describe("line anchor parsing", () => {
    it("single line anchor", () => {
      expect(classifyRepoFileLink("src/foo.ts#L12")).toEqual({
        path: "src/foo.ts",
        lineRange: { start: 12, end: 12 },
      });
    });

    it("range anchor with L on both sides", () => {
      expect(classifyRepoFileLink("src/foo.ts#L12-L34")).toEqual({
        path: "src/foo.ts",
        lineRange: { start: 12, end: 34 },
      });
    });

    it("range anchor with bare end number", () => {
      expect(classifyRepoFileLink("src/foo.ts#L12-34")).toEqual({
        path: "src/foo.ts",
        lineRange: { start: 12, end: 34 },
      });
    });

    it("case-insensitive anchor", () => {
      expect(classifyRepoFileLink("src/foo.ts#l5")).toEqual({
        path: "src/foo.ts",
        lineRange: { start: 5, end: 5 },
      });
    });

    it("drops an end < start range as unparseable", () => {
      expect(classifyRepoFileLink("src/foo.ts#L34-L12")).toEqual({
        path: "src/foo.ts",
      });
    });

    it("drops a non-line anchor but keeps the path", () => {
      expect(classifyRepoFileLink("src/foo.ts#section-heading")).toEqual({
        path: "src/foo.ts",
      });
    });
  });

  describe("rejects dangerous and external schemes", () => {
    it.each([
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,<script>",
      "vbscript:msgbox",
      "file:///etc/passwd",
      "http://example.com/foo.ts",
      "https://example.com/foo.ts",
      "mailto:a@b.com",
      "ftp://host/foo.ts",
      "//evil.com/foo.ts",
    ])("rejects %s", (href) => {
      expect(classifyRepoFileLink(href)).toBeNull();
    });
  });

  describe("rejects path traversal", () => {
    it.each([
      "../secrets.ts",
      "src/../../secrets.ts",
      "./../foo.ts",
      "/../../etc/passwd",
      "a/b/../../../c.ts",
    ])("rejects %s", (href) => {
      expect(classifyRepoFileLink(href)).toBeNull();
    });
  });

  describe("rejects non-file inputs", () => {
    it.each(["", "   ", "#L1", "src/foo.ts?raw=1", "/", "./", "../"])(
      "rejects %s",
      (href) => {
        expect(classifyRepoFileLink(href)).toBeNull();
      },
    );
  });
});

describe("isMarkdownFile", () => {
  it.each(["README.md", "docs/guide.mdx", "A.MD", "b.MdX", "path/to/x.md"])(
    "detects %s as markdown",
    (path) => {
      expect(isMarkdownFile(path)).toBe(true);
    },
  );

  it.each(["src/foo.ts", "notes.markdown", "mdfile", "x.md.ts", "README"])(
    "does not detect %s as markdown",
    (path) => {
      expect(isMarkdownFile(path)).toBe(false);
    },
  );
});
