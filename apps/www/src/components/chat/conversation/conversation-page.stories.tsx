import type { Story, StoryDefault } from "@ladle/react";
import { Fragment } from "react";
import {
  Conversation,
  ConversationContent,
} from "@/components/ai/conversation";
import type { TranscriptItem } from "../transcript-store/transcript-item";
import { ConversationContextProvider } from "./conversation-context";
import { renderLeaf } from "./registry";
import { SeededProvider } from "./seeded-context";

const ITEMS: TranscriptItem[] = [
  {
    kind: "user",
    key: "u1",
    runId: null,
    seq: 0,
    messageId: "m-u1",
    content: [
      {
        type: "text",
        text: "Fix the failing schema-version test in packages/shared and open a PR.",
      },
    ],
  },
  {
    kind: "reasoning",
    key: "re1",
    runId: "r1",
    seq: 1,
    messageId: "m-re1",
    text: "The assertion expects version 11 but the constant was bumped to 12. I'll update the test, run it, then open a PR.",
    streaming: false,
    steps: [],
  },
  {
    kind: "text",
    key: "t1",
    runId: "r1",
    seq: 2,
    messageId: "m-t1",
    text: "I found the mismatch in `db-message.test.ts`. The assertion is off by one against `DB_MESSAGE_SCHEMA_VERSION`. Updating it now.",
    streaming: false,
  },
  {
    kind: "tool",
    key: "to1",
    runId: "r1",
    seq: 3,
    toolCallId: "tc1",
    name: "Read",
    argsText: JSON.stringify({
      file_path: "packages/shared/src/db/db-message.test.ts",
    }),
    parsedArgs: { file_path: "packages/shared/src/db/db-message.test.ts" },
    result: "42 lines read",
    isError: false,
    status: "success",
    streamingArgs: false,
    parentMessageId: null,
  },
  {
    kind: "terminal",
    key: "te1",
    runId: "r1",
    seq: 4,
    terminalId: "term1",
    chunks: [
      {
        streamSeq: 0,
        stream: "stdout",
        text: "$ pnpm -C packages/shared test\n\n Test Files  1 passed (1)\n      Tests  8 passed (8)\n",
      },
    ],
    exitCode: 0,
  },
  {
    kind: "diff",
    key: "d1",
    runId: "r1",
    seq: 5,
    diffId: "diff1",
    filePath: "packages/shared/src/db/db-message.test.ts",
    oldContent: "expect(DB_MESSAGE_SCHEMA_VERSION).toBe(11);\n",
    newContent: "expect(DB_MESSAGE_SCHEMA_VERSION).toBe(12);\n",
    unifiedDiff: null,
    changeKind: "modified",
    status: "applied",
  },
  {
    kind: "plan",
    key: "p1",
    runId: "r1",
    seq: 6,
    planId: "plan1",
    entries: [
      {
        id: "1",
        content: "Locate the failing assertion",
        status: "completed",
        priority: "high",
      },
      {
        id: "2",
        content: "Update the expected schema version",
        status: "in_progress",
        priority: "medium",
      },
      {
        id: "3",
        content: "Open a PR against main",
        status: "pending",
        priority: "low",
      },
    ],
  },
  {
    kind: "permission",
    key: "pm1",
    runId: "r1",
    seq: 7,
    permissionRequestId: "perm1",
    title: "Run git push to origin?",
    description: "git push origin chore/schema-version-fix",
    options: [
      { kind: "allow", name: "Allow", optionId: "allow" },
      { kind: "deny", name: "Deny", optionId: "deny" },
    ],
    decision: null,
    status: "pending",
  },
  {
    kind: "error",
    key: "er1",
    runId: "r1",
    seq: 8,
    errorId: "err1",
    message: "Push rejected: the remote branch is ahead. Pull before pushing.",
    stack: null,
  },
];

const SEEDED_KEYS = ITEMS.map((item) => item.key);

export const FullSkeleton: Story = () => (
  <ConversationContextProvider
    value={{ isReadOnly: false, respondToPermission: () => {} }}
  >
    <div className="h-[90vh]">
      <Conversation className="size-full">
        <ConversationContent className="pt-10 pb-12 px-2.5">
          <div className="nauval-chat-surface mx-auto flex w-full max-w-chat flex-col gap-6 px-4 sm:px-6">
            <SeededProvider keys={SEEDED_KEYS}>
              {ITEMS.map((item) => (
                <Fragment key={item.key}>{renderLeaf(item)}</Fragment>
              ))}
            </SeededProvider>
          </div>
        </ConversationContent>
      </Conversation>
    </div>
  </ConversationContextProvider>
);

export default {
  title: "chat/conversation-page",
} satisfies StoryDefault;
