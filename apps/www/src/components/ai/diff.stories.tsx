import type { Story, StoryDefault } from "@ladle/react";
import {
  Diff,
  DiffContent,
  DiffFile,
  DiffFileHeader,
  DiffFileName,
  DiffFilePanel,
  DiffRow,
  DiffStat,
  type UseDiffInput,
  useDiff,
} from "./diff";

function DiffView({
  input,
  name,
  defaultOpen = true,
}: {
  input: UseDiffInput;
  name: string;
  defaultOpen?: boolean;
}) {
  const result = useDiff(input);
  return (
    <Diff className="my-2">
      <DiffContent>
        <DiffFile defaultOpen={defaultOpen}>
          <DiffFileHeader>
            <DiffFileName>{result.name ?? name}</DiffFileName>
            <DiffStat kind="added">+{result.additions}</DiffStat>
            <DiffStat kind="removed">-{result.removals}</DiffStat>
          </DiffFileHeader>
          <DiffFilePanel>
            {result.lines.map((entry) => (
              <DiffRow key={entry.key} entry={entry} />
            ))}
          </DiffFilePanel>
        </DiffFile>
      </DiffContent>
    </Diff>
  );
}

const ORCHESTRATOR_FROM = `export async function resume(id: string) {
  const handle = await getSession(id);
  return handle.run();
}`;

const ORCHESTRATOR_TO = `export async function resume(id: string) {
  const handle = await getSession(id);
  if (!handle) {
    return startResume(id);
  }
  return handle.run();
}`;

const CONFIG_FROM = `{
  "name": "terragon",
  "version": "1.4.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build"
  }
}`;

const CONFIG_TO = `{
  "name": "terragon",
  "version": "1.5.0",
  "private": true,
  "scripts": {
    "dev": "next dev --turbopack",
    "build": "next build",
    "test": "vitest run"
  }
}`;

const PATCH = `--- a/src/agent/orchestrator.ts
+++ b/src/agent/orchestrator.ts
@@ -10,5 +10,6 @@ export class Orchestrator {
   async resume(id: string) {
-    const handle = await getSession(id);
-    return handle.run();
+    const handle = await getSession(id);
+    if (!handle) return this.startResume(id);
+    return handle.run();
   }
 }`;

const CONTEXT_FROM = `import { getSession } from "./session";
import { logger } from "./logger";
import { metrics } from "./metrics";

export async function resume(id: string) {
  const handle = await getSession(id);
  return handle.run();
}

export function shutdown() {
  metrics.flush();
  logger.info("shutdown complete");
}`;

const CONTEXT_TO = `import { getSession } from "./session";
import { logger } from "./logger";
import { metrics } from "./metrics";

export async function resume(id: string) {
  const handle = await getSession(id);
  if (!handle) return startResume(id);
  return handle.run();
}

export function shutdown() {
  metrics.flush();
  logger.info("shutdown complete");
}`;

const ADD_ONLY_TO = `line one
line two
line three
line four`;

export const WordLevelFromStrings: Story = () => {
  return (
    <div className="nauval-chat-surface p-6 max-w-2xl">
      <DiffView
        name="src/agent/orchestrator.ts"
        input={{
          from: ORCHESTRATOR_FROM,
          to: ORCHESTRATOR_TO,
          contextLines: 3,
        }}
      />
    </div>
  );
};

export const FromUnifiedPatch: Story = () => {
  return (
    <div className="nauval-chat-surface p-6 max-w-2xl">
      <DiffView
        name="src/agent/orchestrator.ts"
        input={{ patch: PATCH, contextLines: 3 }}
      />
    </div>
  );
};

export const CollapsedFile: Story = () => {
  return (
    <div className="nauval-chat-surface p-6 max-w-2xl">
      <DiffView
        name="src/agent/orchestrator.ts"
        defaultOpen={false}
        input={{
          from: ORCHESTRATOR_FROM,
          to: ORCHESTRATOR_TO,
          contextLines: 3,
        }}
      />
    </div>
  );
};

export const ContextCollapse: Story = () => {
  return (
    <div className="nauval-chat-surface p-6 max-w-2xl">
      <DiffView
        name="src/agent/orchestrator.ts"
        input={{ from: CONTEXT_FROM, to: CONTEXT_TO, contextLines: 1 }}
      />
    </div>
  );
};

export const AddOnly: Story = () => {
  return (
    <div className="nauval-chat-surface p-6 max-w-2xl">
      <DiffView
        name="notes.txt"
        input={{ from: "", to: ADD_ONLY_TO, contextLines: 3 }}
      />
    </div>
  );
};

export const RemoveOnly: Story = () => {
  return (
    <div className="nauval-chat-surface p-6 max-w-2xl">
      <DiffView
        name="notes.txt"
        input={{ from: ADD_ONLY_TO, to: "", contextLines: 3 }}
      />
    </div>
  );
};

export const MultipleFiles: Story = () => {
  const orchestrator = useDiff({
    from: ORCHESTRATOR_FROM,
    to: ORCHESTRATOR_TO,
    contextLines: 3,
  });
  const config = useDiff({ from: CONFIG_FROM, to: CONFIG_TO, contextLines: 3 });
  const files = [
    { name: "src/agent/orchestrator.ts", result: orchestrator },
    { name: "package.json", result: config },
  ];
  return (
    <div className="nauval-chat-surface p-6 max-w-2xl">
      <Diff className="my-2">
        <DiffContent>
          {files.map((file) => (
            <DiffFile key={file.name}>
              <DiffFileHeader>
                <DiffFileName>{file.name}</DiffFileName>
                <DiffStat kind="added">+{file.result.additions}</DiffStat>
                <DiffStat kind="removed">-{file.result.removals}</DiffStat>
              </DiffFileHeader>
              <DiffFilePanel>
                {file.result.lines.map((entry) => (
                  <DiffRow key={entry.key} entry={entry} />
                ))}
              </DiffFilePanel>
            </DiffFile>
          ))}
        </DiffContent>
      </Diff>
    </div>
  );
};

export default {
  title: "ai/diff",
} satisfies StoryDefault;
