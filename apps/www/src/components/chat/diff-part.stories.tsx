import type { Story, StoryDefault } from "@ladle/react";
import { DiffPartView } from "./diff-part";
import type { DBDiffPart } from "@terragon/shared";

export default {
  title: "Chat/DiffPartView",
} satisfies StoryDefault;

const basePart: DBDiffPart = {
  type: "diff",
  filePath: "src/components/button.tsx",
  oldContent:
    "export function Button() {\n  return <button>Click</button>;\n}\n",
  newContent:
    "export function Button({ label }: { label: string }) {\n  return <button>{label}</button>;\n}\n",
  unifiedDiff: `--- a/src/components/button.tsx
+++ b/src/components/button.tsx
@@ -1,3 +1,3 @@
-export function Button() {
-  return <button>Click</button>;
+export function Button({ label }: { label: string }) {
+  return <button>{label}</button>;
 }`,
  status: "pending",
};

export const Pending: Story = () => (
  <div className="p-4 max-w-xl">
    <DiffPartView
      part={{ ...basePart, status: "pending" }}
      onAccept={() => alert("accepted")}
      onReject={() => alert("rejected")}
    />
  </div>
);

export const Applied: Story = () => (
  <div className="p-4 max-w-xl">
    <DiffPartView part={{ ...basePart, status: "applied" }} />
  </div>
);

export const Rejected: Story = () => (
  <div className="p-4 max-w-xl">
    <DiffPartView part={{ ...basePart, status: "rejected" }} />
  </div>
);
