import type { Story, StoryDefault } from "@ladle/react";
import { Diff, DiffContent } from "./diff";
import { DiffRichFile } from "./diff-rich";

function Surface({ children }: { children: React.ReactNode }) {
  return <div className="nauval-chat-surface p-6 max-w-2xl">{children}</div>;
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <Diff className="my-2">
      <DiffContent>{children}</DiffContent>
    </Diff>
  );
}

const TS_FROM = `import { getSession } from "./session";

export async function resume(id: string) {
  const handle = await getSession(id);
  return handle.run();
}`;

const TS_TO = `import { getSession } from "./session";
import { logger } from "./logger";

export async function resume(id: string) {
  const handle = await getSession(id);
  if (!handle) {
    logger.warn("no session", id);
    return startResume(id);
  }
  return handle.run();
}`;

const JSON_FROM = `{
  "name": "terragon",
  "version": "1.4.0",
  "scripts": {
    "dev": "next dev"
  }
}`;

const JSON_TO = `{
  "name": "terragon",
  "version": "1.5.0",
  "scripts": {
    "dev": "next dev --turbopack",
    "test": "vitest run"
  }
}`;

const PY_FROM = `def resume(session_id):
    handle = get_session(session_id)
    return handle.run()`;

const PY_TO = `def resume(session_id):
    handle = get_session(session_id)
    if handle is None:
        return start_resume(session_id)
    return handle.run()`;

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

const TXT_FROM = `alpha
beta
gamma`;

const TXT_TO = `alpha
beta prime
gamma
delta`;

const BIG_FROM = Array.from(
  { length: 40 },
  (_, i) => `const v${i} = ${i};`,
).join("\n");
const BIG_TO = Array.from(
  { length: 40 },
  (_, i) => `const v${i} = ${i + 1};`,
).join("\n");

const LOCK_FROM = `lockfileVersion: '9.0'
dependencies:
  react:
    specifier: 19.1.0`;

const LOCK_TO = `lockfileVersion: '9.0'
dependencies:
  react:
    specifier: 19.1.0
  jotai:
    specifier: 2.9.0`;

export const HighlightedTypeScript: Story = () => (
  <Surface>
    <Frame>
      <DiffRichFile
        filename="src/agent/orchestrator.ts"
        from={TS_FROM}
        to={TS_TO}
      />
    </Frame>
  </Surface>
);

export const HighlightedJson: Story = () => (
  <Surface>
    <Frame>
      <DiffRichFile filename="package.json" from={JSON_FROM} to={JSON_TO} />
    </Frame>
  </Surface>
);

export const HighlightedPython: Story = () => (
  <Surface>
    <Frame>
      <DiffRichFile
        filename="agent/orchestrator.py"
        from={PY_FROM}
        to={PY_TO}
      />
    </Frame>
  </Surface>
);

export const FromPatchPlain: Story = () => (
  <Surface>
    <Frame>
      <DiffRichFile filename="src/agent/orchestrator.ts" patch={PATCH} />
    </Frame>
  </Surface>
);

export const Collapsed: Story = () => (
  <Surface>
    <Frame>
      <DiffRichFile
        filename="src/agent/orchestrator.ts"
        from={TS_FROM}
        to={TS_TO}
        defaultOpen={false}
      />
    </Frame>
  </Surface>
);

export const UnknownLanguagePlain: Story = () => (
  <Surface>
    <Frame>
      <DiffRichFile filename="notes.txt" from={TXT_FROM} to={TXT_TO} />
    </Frame>
  </Surface>
);

export const IgnoredLockfilePlain: Story = () => (
  <Surface>
    <Frame>
      <DiffRichFile filename="pnpm-lock.yaml" from={LOCK_FROM} to={LOCK_TO} />
    </Frame>
  </Surface>
);

export const LargeFileNoHighlight: Story = () => (
  <Surface>
    <Frame>
      <DiffRichFile
        filename="src/generated/constants.ts"
        from={BIG_FROM}
        to={BIG_TO}
        maxLines={20}
      />
    </Frame>
  </Surface>
);

export const MultipleFiles: Story = () => (
  <Surface>
    <Frame>
      <DiffRichFile
        filename="src/agent/orchestrator.ts"
        from={TS_FROM}
        to={TS_TO}
      />
      <DiffRichFile filename="package.json" from={JSON_FROM} to={JSON_TO} />
      <DiffRichFile filename="notes.txt" from={TXT_FROM} to={TXT_TO} />
    </Frame>
  </Surface>
);

export default {
  title: "ai/diff-rich",
} satisfies StoryDefault;
