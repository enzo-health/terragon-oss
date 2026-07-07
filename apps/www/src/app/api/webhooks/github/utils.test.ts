import { describe, expect, it } from "vitest";
import { getDiffContextStr, extractModelFromComment } from "./utils";

describe("getDiffContextStr", () => {
  it("should format a complete PR review comment context", () => {
    const comment: any = {
      path: "src/components/Button.tsx",
      position: 15,
      line: 42,
      side: "RIGHT",
      start_line: 38,
      start_side: "RIGHT",
      id: 123456,
      in_reply_to_id: 123456,
      diff_hunk: `@@ -35,7 +35,9 @@ export function Button() {
   const [count, setCount] = useState(0);
   
   return (
-    <button onClick={() => setCount(count + 1)}>
+    <button 
+      className="btn-primary"
+      onClick={() => setCount(count + 1)}
+    >
       Count: {count}
     </button>`,
      commit_id: "abc123def456789012345678901234567890abcd",
      original_commit_id: "def456abc789012345678901234567890abcdef1",
      original_position: 12,
      original_line: 40,
    };

    expect(getDiffContextStr(comment)).toMatchInlineSnapshot(`
      "// Side: head, Start line: 38, End line: 42
      Comment id: 123456 | Originally at line 40
      \`\`\`diff
      diff --git a/src/components/Button.tsx b/src/components/Button.tsx
      index def456a..abc123d
      --- a/src/components/Button.tsx
      +++ b/src/components/Button.tsx

      @@ -35,7 +35,9 @@ export function Button() {
         const [count, setCount] = useState(0);
         
         return (
      -    <button onClick={() => setCount(count + 1)}>
      +    <button 
      +      className="btn-primary"
      +      onClick={() => setCount(count + 1)}
      +    >
             Count: {count}
           </button>
      \`\`\`"
    `);
  });

  it("should format a simple comment on the base branch", () => {
    const comment: any = {
      path: "README.md",
      line: 10,
      side: "LEFT",
    };
    expect(getDiffContextStr(comment)).toMatchInlineSnapshot(`
      "// Side: base, Line: 10
      \`\`\`diff
      diff --git a/README.md b/README.md
      --- a/README.md
      +++ b/README.md
      \`\`\`"
    `);
  });

  it("should format a comment with only file and diff hunk", () => {
    const comment: any = {
      path: "src/utils/helper.js",
      diff_hunk: `@@ -15,3 +15,5 @@ function formatDate(date) {
   return date.toLocaleDateString();
 }
+
+// TODO: Add timezone support`,
    };

    expect(getDiffContextStr(comment)).toMatchInlineSnapshot(`
      "\`\`\`diff
      diff --git a/src/utils/helper.js b/src/utils/helper.js
      --- a/src/utils/helper.js
      +++ b/src/utils/helper.js

      @@ -15,3 +15,5 @@ function formatDate(date) {
         return date.toLocaleDateString();
       }
      +
      +// TODO: Add timezone support
      \`\`\`"
    `);
  });

  it("should format a comment that's a reply without file info", () => {
    const comment: any = {
      in_reply_to_id: 789012,
      commit_id: "1234567890abcdef",
    };

    expect(getDiffContextStr(comment)).toMatchInlineSnapshot(
      `"Comment id: undefined"`,
    );
  });

  it("should format an outdated comment", () => {
    const comment: any = {
      path: "src/api/users.ts",
      line: 25,
      side: "RIGHT",
      commit_id: "abc123def456",
      original_commit_id: "xyz789uvw456",
      original_line: 23,
    };

    expect(getDiffContextStr(comment)).toMatchInlineSnapshot(`
      "// Side: head, Line: 25
      Originally at line 23
      \`\`\`diff
      diff --git a/src/api/users.ts b/src/api/users.ts
      index xyz789u..abc123d
      --- a/src/api/users.ts
      +++ b/src/api/users.ts
      \`\`\`"
    `);
  });

  it("should handle empty comment object", () => {
    const comment: any = {};

    expect(getDiffContextStr(comment)).toMatchInlineSnapshot(`""`);
  });

  it("should format multi-line comment range on base branch", () => {
    const comment: any = {
      path: "src/config.json",
      line: 50,
      side: "LEFT",
      start_line: 45,
      start_side: "LEFT",
    };

    expect(getDiffContextStr(comment)).toMatchInlineSnapshot(`
      "// Side: base, Start line: 45, End line: 50
      \`\`\`diff
      diff --git a/src/config.json b/src/config.json
      --- a/src/config.json
      +++ b/src/config.json
      \`\`\`"
    `);
  });

  it("should handle comment with position but no line", () => {
    const comment: any = {
      path: "package.json",
      position: 20,
      side: "RIGHT",
    };

    expect(getDiffContextStr(comment)).toMatchInlineSnapshot(`
      "// Side: head, Line: undefined
      \`\`\`diff
      diff --git a/package.json b/package.json
      --- a/package.json
      +++ b/package.json
      \`\`\`"
    `);
  });

  it("should format comment with single commit", () => {
    const comment: any = {
      path: "src/index.js",
      line: 15,
      side: "RIGHT",
      commit_id: "abc123def456789",
      diff_hunk: `@@ -12,3 +12,4 @@ import React from 'react';
 
 export default App;
+// New comment`,
    };

    expect(getDiffContextStr(comment)).toMatchInlineSnapshot(`
      "// Side: head, Line: 15
      \`\`\`diff
      diff --git a/src/index.js b/src/index.js
      index abc123d
      --- a/src/index.js
      +++ b/src/index.js

      @@ -12,3 +12,4 @@ import React from 'react';
       
       export default App;
      +// New comment
      \`\`\`"
    `);
  });
});

describe("extractModelFromComment", () => {
  const appName = "test-app"; // Matches NEXT_PUBLIC_GITHUB_APP_NAME in vite.config.ts

  it("should extract sonnet model from comment", () => {
    const comment = `@${appName} [sonnet] fix this bug`;
    expect(extractModelFromComment({ commentBody: comment })).toBe("sonnet");
  });

  it("should extract opus model from comment", () => {
    const comment = `@${appName} [opus] improve this code`;
    expect(extractModelFromComment({ commentBody: comment })).toBe("opus");
  });

  it("should extract haiku model from comment", () => {
    const comment = `@${appName} [haiku] add documentation`;
    expect(extractModelFromComment({ commentBody: comment })).toBe("haiku");
  });

  it("should extract gpt-5 model from comment", () => {
    const comment = `@${appName} [gpt-5] refactor this`;
    expect(extractModelFromComment({ commentBody: comment })).toBe("gpt-5");
  });

  it("should reject removed gemini model from comment", () => {
    const comment = `@${appName} [gemini-2.5-pro] analyze this`;
    expect(extractModelFromComment({ commentBody: comment })).toBe(null);
  });

  it("should reject removed opencode model from comment", () => {
    const comment = `@${appName} [opencode/qwen3-coder] test this`;
    expect(extractModelFromComment({ commentBody: comment })).toBe(null);
  });

  it("should handle model with no spaces after mention", () => {
    const comment = `@${appName}[sonnet] fix this`;
    expect(extractModelFromComment({ commentBody: comment })).toBe("sonnet");
  });

  it("should handle model with multiple spaces after mention", () => {
    const comment = `@${appName}   [opus] improve this`;
    expect(extractModelFromComment({ commentBody: comment })).toBe("opus");
  });

  it("should handle model name with whitespace inside brackets", () => {
    const comment = `@${appName} [ sonnet ] fix this`;
    expect(extractModelFromComment({ commentBody: comment })).toBe("sonnet");
  });

  it("should return null for invalid model name", () => {
    const comment = `@${appName} [invalid-model] fix this`;
    expect(extractModelFromComment({ commentBody: comment })).toBe(null);
  });

  it("should return null when no model is specified", () => {
    const comment = `@${appName} fix this bug`;
    expect(extractModelFromComment({ commentBody: comment })).toBe(null);
  });

  it("should return null when brackets are empty", () => {
    const comment = `@${appName} [] fix this`;
    expect(extractModelFromComment({ commentBody: comment })).toBe(null);
  });

  it("should return null when brackets contain only whitespace", () => {
    const comment = `@${appName} [   ] fix this`;
    expect(extractModelFromComment({ commentBody: comment })).toBe(null);
  });

  it("should extract first model when multiple models are specified", () => {
    const comment = `@${appName} [sonnet] [opus] fix this`;
    expect(extractModelFromComment({ commentBody: comment })).toBe("sonnet");
  });

  it("should handle model at end of comment", () => {
    const comment = `fix this bug @${appName} [haiku]`;
    expect(extractModelFromComment({ commentBody: comment })).toBe("haiku");
  });

  it("should handle model in middle of comment", () => {
    const comment = `Hey @${appName} [opus] can you help with this issue?`;
    expect(extractModelFromComment({ commentBody: comment })).toBe("opus");
  });

  it("should handle case-insensitive app name", () => {
    const comment = `@${appName.toUpperCase()} [sonnet] fix this`;
    expect(extractModelFromComment({ commentBody: comment })).toBe("sonnet");
  });

  it("should handle multiline comments", () => {
    const comment = `@${appName} [sonnet]
    Please fix this bug:
    - Issue 1
    - Issue 2`;
    expect(extractModelFromComment({ commentBody: comment })).toBe("sonnet");
  });

  it("should ignore brackets that are not after the app mention", () => {
    const comment = `This is a [test] comment. @${appName} fix it`;
    expect(extractModelFromComment({ commentBody: comment })).toBe(null);
  });

  it("should extract model when there are multiple app mentions", () => {
    const comment = `@${appName} [sonnet] and also @${appName} help`;
    expect(extractModelFromComment({ commentBody: comment })).toBe("sonnet");
  });
});
