import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export type Finding = {
  rule: string;
  file: string;
  line: number;
  message: string;
};

type RuleId =
  | "no-legacy-runtime-imports"
  | "no-unsafe-runtime-boundary-casts"
  | "require-exhaustive-switch";

type AllowlistEntry = {
  rule: RuleId;
  file: string;
  line: number;
  owner: string;
  reason: string;
  deletionCriterion: string;
};

export type ArchitectureLintConfig = {
  legacyRuntimeImportRoots: string[];
  unsafeCastRoots: string[];
  exhaustiveSwitchFiles: string[];
  allowlist: AllowlistEntry[];
};

const legacyRuntimeImportSegment = ["delivery", "loop"].join("-");

const sourceExtensions = new Set([".ts", ".tsx", ".mts", ".cts"]);
const ignoredDirectories = new Set([
  ".git",
  ".next",
  "dist",
  "node_modules",
  "test-results",
]);

export const defaultConfig: ArchitectureLintConfig = {
  legacyRuntimeImportRoots: [
    "apps/www/src/agent",
    "apps/www/src/agent/runtime",
    "apps/www/src/app/(sidebar)/(task-list)",
    "apps/www/src/app/api/ag-ui",
    "apps/www/src/app/api/daemon-event",
    "apps/www/src/app/api/internal/cron",
    "apps/www/src/app/api/internal/process-scheduled-task",
    "apps/www/src/app/api/internal/process-thread-queue",
    "apps/www/src/app/api/webhooks",
    "apps/www/src/components/chat",
    "apps/www/src/components/promptbox",
    "apps/www/src/components/thread-list",
    "apps/www/src/hooks",
    "apps/www/src/queries",
    "apps/www/src/server-actions",
    "apps/www/src/server-lib/handle-daemon-event.ts",
    "apps/cli/src/commands",
    "packages/agent/src",
    "packages/daemon/src",
  ],
  unsafeCastRoots: [
    "apps/www/src/agent/runtime",
    "apps/www/src/app/api/daemon-event/route.ts",
    "apps/www/src/app/api/webhooks",
    "apps/www/src/components/chat/ag-ui-messages-reducer.ts",
    "apps/www/src/components/chat/db-messages-to-ag-ui.ts",
    "apps/www/src/components/chat/toUIMessages.ts",
    "apps/cli/src",
    "packages/agent/src",
    "packages/daemon/src",
    "packages/shared/src/model/agent-event-log.ts",
    "apps/www/src/components/chat/thread-view-model",
    "packages/agent/src/canonical-events.ts",
  ],
  exhaustiveSwitchFiles: [
    "apps/www/src/components/chat/message-part.tsx",
    "apps/www/src/components/chat/ag-ui-messages-reducer.ts",
    "apps/www/src/components/chat/db-messages-to-ag-ui.ts",
    "apps/www/src/components/chat/thread-view-model/reducer.ts",
    "packages/agent/src/ag-ui-mapper.ts",
    "packages/shared/src/model/agent-event-log.ts",
  ],
  allowlist: [
    ...baselineRuleLineDebtAllowlist("require-exhaustive-switch", [
      {
        file: "apps/www/src/components/chat/ag-ui-messages-reducer.ts",
        line: 602,
      },
      {
        file: "apps/www/src/components/chat/thread-view-model/reducer.ts",
        line: 519,
      },
      {
        file: "apps/www/src/components/chat/thread-view-model/reducer.ts",
        line: 577,
      },
      {
        file: "apps/www/src/components/chat/thread-view-model/reducer.ts",
        line: 755,
      },
      {
        file: "apps/www/src/components/chat/thread-view-model/reducer.ts",
        line: 899,
      },
    ]),
    {
      rule: "no-unsafe-runtime-boundary-casts",
      file: "apps/www/src/app/api/webhooks/linear/route.ts",
      line: 167,
      owner: "smooth-runtime-rewrite",
      reason: "Linear webhook route still casts provider payloads at ingress",
      deletionCriterion:
        "remove after Linear webhook payloads have typed runtime parsers",
    },
    {
      rule: "no-unsafe-runtime-boundary-casts",
      file: "apps/www/src/app/api/webhooks/linear/route.ts",
      line: 177,
      owner: "smooth-runtime-rewrite",
      reason:
        "Linear webhook route still casts provider notification payloads at ingress",
      deletionCriterion:
        "remove after Linear notification payloads have typed runtime parsers",
    },
    {
      rule: "no-unsafe-runtime-boundary-casts",
      file: "apps/www/src/components/chat/ag-ui-messages-reducer.ts",
      line: 440,
      owner: "smooth-runtime-rewrite",
      reason:
        "AG-UI reducer still bridges extended Terragon tool parts into assistant-ui UIPart",
      deletionCriterion:
        "remove after assistant-ui part types include Terragon tool parts directly",
    },
    {
      rule: "no-unsafe-runtime-boundary-casts",
      file: "apps/www/src/components/chat/ag-ui-messages-reducer.ts",
      line: 522,
      owner: "smooth-runtime-rewrite",
      reason:
        "AG-UI reducer still dedupes id-like extended parts through structural inspection",
      deletionCriterion:
        "remove after rich parts share a typed id-bearing base",
    },
    {
      rule: "no-unsafe-runtime-boundary-casts",
      file: "apps/www/src/components/chat/ag-ui-messages-reducer.ts",
      line: 525,
      owner: "smooth-runtime-rewrite",
      reason:
        "AG-UI reducer still dedupes existing assistant-ui parts through structural inspection",
      deletionCriterion:
        "remove after rich parts share a typed id-bearing base",
    },
    {
      rule: "no-unsafe-runtime-boundary-casts",
      file: "apps/www/src/components/chat/toUIMessages.ts",
      line: 111,
      owner: "smooth-runtime-rewrite",
      reason:
        "legacy DB-to-UI mapper mutates assistant-ui tool parts through an untyped compatibility shape",
      deletionCriterion:
        "remove after DB tool interruptions project through typed assistant-ui helpers",
    },
    {
      rule: "no-unsafe-runtime-boundary-casts",
      file: "apps/www/src/components/chat/toUIMessages.ts",
      line: 112,
      owner: "smooth-runtime-rewrite",
      reason:
        "legacy DB-to-UI mapper mutates assistant-ui tool parts through an untyped compatibility shape",
      deletionCriterion:
        "remove after DB tool interruptions project through typed assistant-ui helpers",
    },
    {
      rule: "no-unsafe-runtime-boundary-casts",
      file: "apps/cli/src/index.tsx",
      line: 134,
      owner: "smooth-runtime-rewrite",
      reason:
        "CLI model option parsing still narrows Commander strings through an unsafe include check",
      deletionCriterion:
        "remove after CLI option parsing uses a typed model parser",
    },
    {
      rule: "no-unsafe-runtime-boundary-casts",
      file: "packages/daemon/src/acp-codex-adapter.ts",
      line: 209,
      owner: "smooth-runtime-rewrite",
      reason:
        "ACP Codex adapter still normalizes provider events at an ingress boundary",
      deletionCriterion:
        "remove after Codex provider events have schema-backed ACP conversion",
    },
    {
      rule: "no-unsafe-runtime-boundary-casts",
      file: "packages/daemon/src/claude.ts",
      line: 392,
      owner: "smooth-runtime-rewrite",
      reason:
        "Claude adapter still hydrates provider JSON into Claude message types",
      deletionCriterion:
        "remove after Claude streaming parser is schema-backed",
    },
    {
      rule: "no-unsafe-runtime-boundary-casts",
      file: "packages/daemon/src/claude.ts",
      line: 556,
      owner: "smooth-runtime-rewrite",
      reason:
        "Claude adapter still hydrates provider JSON into Claude message types",
      deletionCriterion:
        "remove after Claude streaming parser is schema-backed",
    },
    {
      rule: "no-unsafe-runtime-boundary-casts",
      file: "packages/daemon/src/claude.ts",
      line: 565,
      owner: "smooth-runtime-rewrite",
      reason:
        "Claude adapter still hydrates provider JSON into Claude message types",
      deletionCriterion:
        "remove after Claude streaming parser is schema-backed",
    },
    {
      rule: "no-unsafe-runtime-boundary-casts",
      file: "packages/daemon/src/codex-app-server.ts",
      line: 854,
      owner: "smooth-runtime-rewrite",
      reason:
        "Codex app server still fabricates thread items for provider replay",
      deletionCriterion:
        "remove after thread item construction uses typed builders",
    },
    {
      rule: "no-unsafe-runtime-boundary-casts",
      file: "packages/daemon/src/codex-app-server.ts",
      line: 874,
      owner: "smooth-runtime-rewrite",
      reason:
        "Codex app server still fabricates thread items for provider replay",
      deletionCriterion:
        "remove after thread item construction uses typed builders",
    },
    {
      rule: "no-unsafe-runtime-boundary-casts",
      file: "packages/daemon/src/codex-app-server.ts",
      line: 898,
      owner: "smooth-runtime-rewrite",
      reason:
        "Codex app server still fabricates thread items for provider replay",
      deletionCriterion:
        "remove after thread item construction uses typed builders",
    },
    {
      rule: "no-unsafe-runtime-boundary-casts",
      file: "packages/daemon/src/codex-app-server.ts",
      line: 918,
      owner: "smooth-runtime-rewrite",
      reason:
        "Codex app server still fabricates thread items for provider replay",
      deletionCriterion:
        "remove after thread item construction uses typed builders",
    },
    {
      rule: "no-unsafe-runtime-boundary-casts",
      file: "packages/daemon/src/codex-app-server.ts",
      line: 938,
      owner: "smooth-runtime-rewrite",
      reason:
        "Codex app server still fabricates thread items for provider replay",
      deletionCriterion:
        "remove after thread item construction uses typed builders",
    },
    {
      rule: "no-unsafe-runtime-boundary-casts",
      file: "packages/daemon/src/codex-app-server.ts",
      line: 968,
      owner: "smooth-runtime-rewrite",
      reason:
        "Codex app server still fabricates thread items for provider replay",
      deletionCriterion:
        "remove after thread item construction uses typed builders",
    },
    {
      rule: "no-unsafe-runtime-boundary-casts",
      file: "packages/daemon/src/codex-app-server.ts",
      line: 1002,
      owner: "smooth-runtime-rewrite",
      reason:
        "Codex app server still fabricates thread items for provider replay",
      deletionCriterion:
        "remove after thread item construction uses typed builders",
    },
    {
      rule: "no-unsafe-runtime-boundary-casts",
      file: "packages/daemon/src/codex-app-server.ts",
      line: 1087,
      owner: "smooth-runtime-rewrite",
      reason:
        "Codex app server still bridges normalized provider items into thread item shape",
      deletionCriterion:
        "remove after normalized provider items are typed before persistence",
    },
    {
      rule: "no-unsafe-runtime-boundary-casts",
      file: "packages/daemon/src/codex-app-server.ts",
      line: 1152,
      owner: "smooth-runtime-rewrite",
      reason:
        "Codex app server still bridges normalized provider items into thread item shape",
      deletionCriterion:
        "remove after normalized provider items are typed before persistence",
    },
    {
      rule: "no-unsafe-runtime-boundary-casts",
      file: "packages/daemon/src/codex-app-server.ts",
      line: 1210,
      owner: "smooth-runtime-rewrite",
      reason:
        "Codex app server still bridges normalized provider items into thread item shape",
      deletionCriterion:
        "remove after normalized provider items are typed before persistence",
    },
    {
      rule: "no-unsafe-runtime-boundary-casts",
      file: "packages/daemon/src/codex.ts",
      line: 204,
      owner: "smooth-runtime-rewrite",
      reason:
        "Codex adapter still narrows provider item payloads at runtime ingress",
      deletionCriterion:
        "remove after Codex provider item schemas are canonical",
    },
    {
      rule: "no-unsafe-runtime-boundary-casts",
      file: "packages/daemon/src/codex.ts",
      line: 995,
      owner: "smooth-runtime-rewrite",
      reason:
        "Codex adapter still narrows provider items to CodexItemEvent without schema parsing",
      deletionCriterion:
        "remove after Codex item events are parsed through canonical schemas",
    },
    {
      rule: "no-unsafe-runtime-boundary-casts",
      file: "packages/daemon/src/codex.ts",
      line: 1093,
      owner: "smooth-runtime-rewrite",
      reason:
        "Codex adapter still narrows auto-approval review items at runtime ingress",
      deletionCriterion:
        "remove after auto-approval review payloads have schema-backed parsing",
    },
    {
      rule: "no-unsafe-runtime-boundary-casts",
      file: "packages/daemon/src/opencode.ts",
      line: 72,
      owner: "smooth-runtime-rewrite",
      reason:
        "OpenCode adapter still hydrates provider JSON into OpencodeEvent without schema parsing",
      deletionCriterion:
        "remove after OpenCode provider events have schema-backed parsing",
    },
    {
      rule: "no-unsafe-runtime-boundary-casts",
      file: "packages/daemon/src/daemon.ts",
      line: 4031,
      owner: "smooth-runtime-rewrite",
      reason:
        "daemon still reads session id from provider output through untyped ACP payload",
      deletionCriterion:
        "remove after ACP output message payloads expose a typed session id",
    },
    {
      rule: "no-unsafe-runtime-boundary-casts",
      file: "packages/daemon/src/daemon.ts",
      line: 4333,
      owner: "smooth-runtime-rewrite",
      reason:
        "daemon still reads provider tool input from untyped stream content",
      deletionCriterion:
        "remove after provider tool content is schema-normalized before handling",
    },
    ...baselineUnsafeCastDebtAllowlist([
      {
        file: "apps/www/src/agent/runtime/implementation-adapter.ts",
        line: 119,
      },
      { file: "apps/www/src/app/api/webhooks/linear/handlers.ts", line: 671 },
      { file: "apps/www/src/app/api/webhooks/linear/handlers.ts", line: 682 },
      {
        file: "apps/www/src/components/chat/ag-ui-messages-reducer.ts",
        line: 388,
      },
      {
        file: "apps/www/src/components/chat/ag-ui-messages-reducer.ts",
        line: 414,
      },
      {
        file: "apps/www/src/components/chat/ag-ui-messages-reducer.ts",
        line: 442,
      },
      {
        file: "apps/www/src/components/chat/ag-ui-messages-reducer.ts",
        line: 447,
      },
      {
        file: "apps/www/src/components/chat/ag-ui-messages-reducer.ts",
        line: 472,
      },
      {
        file: "apps/www/src/components/chat/ag-ui-messages-reducer.ts",
        line: 495,
      },
      {
        file: "apps/www/src/components/chat/ag-ui-messages-reducer.ts",
        line: 538,
      },
      {
        file: "apps/www/src/components/chat/ag-ui-messages-reducer.ts",
        line: 550,
      },
      {
        file: "apps/www/src/components/chat/ag-ui-messages-reducer.ts",
        line: 583,
      },
      {
        file: "apps/www/src/components/chat/ag-ui-messages-reducer.ts",
        line: 619,
      },
      {
        file: "apps/www/src/components/chat/db-messages-to-ag-ui.ts",
        line: 194,
      },
      {
        file: "apps/www/src/components/chat/thread-view-model/ag-ui-adapter.ts",
        line: 104,
      },
      {
        file: "apps/www/src/components/chat/thread-view-model/legacy-db-message-adapter.ts",
        line: 77,
      },
      {
        file: "apps/www/src/components/chat/thread-view-model/legacy-db-message-adapter.ts",
        line: 78,
      },
      {
        file: "apps/www/src/components/chat/thread-view-model/legacy-db-message-adapter.ts",
        line: 240,
      },
      {
        file: "apps/www/src/components/chat/thread-view-model/reducer.ts",
        line: 712,
      },
      {
        file: "apps/www/src/components/chat/thread-view-model/reducer.ts",
        line: 729,
      },
      {
        file: "apps/www/src/components/chat/thread-view-model/reducer.ts",
        line: 844,
      },
      {
        file: "apps/www/src/components/chat/thread-view-model/reducer.ts",
        line: 871,
      },
      {
        file: "apps/www/src/components/chat/thread-view-model/reducer.ts",
        line: 888,
      },
      { file: "apps/www/src/components/chat/toUIMessages.ts", line: 296 },
      { file: "packages/daemon/src/acp-adapter.ts", line: 93 },
      { file: "packages/daemon/src/acp-adapter.ts", line: 140 },
      { file: "packages/daemon/src/acp-adapter.ts", line: 195 },
      { file: "packages/daemon/src/acp-adapter.ts", line: 214 },
      { file: "packages/daemon/src/acp-adapter.ts", line: 215 },
      { file: "packages/daemon/src/acp-adapter.ts", line: 224 },
      { file: "packages/daemon/src/acp-adapter.ts", line: 281 },
      { file: "packages/daemon/src/acp-adapter.ts", line: 462 },
      { file: "packages/daemon/src/acp-adapter.ts", line: 474 },
      { file: "packages/daemon/src/acp-adapter.ts", line: 569 },
      { file: "packages/daemon/src/acp-adapter.ts", line: 640 },
      { file: "packages/daemon/src/acp-adapter.ts", line: 680 },
      { file: "packages/daemon/src/acp-adapter.ts", line: 807 },
      { file: "packages/daemon/src/daemon.ts", line: 165 },
      { file: "packages/daemon/src/daemon.ts", line: 166 },
      { file: "packages/daemon/src/daemon.ts", line: 190 },
      { file: "packages/daemon/src/daemon.ts", line: 473 },
      { file: "packages/daemon/src/daemon.ts", line: 1419 },
      { file: "packages/daemon/src/daemon.ts", line: 1621 },
      { file: "packages/daemon/src/daemon.ts", line: 1720 },
      { file: "packages/daemon/src/daemon.ts", line: 1723 },
      { file: "packages/daemon/src/daemon.ts", line: 1771 },
      { file: "packages/daemon/src/daemon.ts", line: 1772 },
      { file: "packages/daemon/src/daemon.ts", line: 1773 },
      { file: "packages/daemon/src/daemon.ts", line: 1796 },
      { file: "packages/daemon/src/daemon.ts", line: 1797 },
      { file: "packages/daemon/src/daemon.ts", line: 1798 },
      { file: "packages/daemon/src/daemon.ts", line: 1820 },
      { file: "packages/daemon/src/daemon.ts", line: 1821 },
      { file: "packages/daemon/src/daemon.ts", line: 1822 },
      { file: "packages/daemon/src/daemon.ts", line: 2307 },
      { file: "packages/daemon/src/daemon.ts", line: 2383 },
      { file: "packages/daemon/src/daemon.ts", line: 3041 },
      { file: "packages/daemon/src/daemon.ts", line: 4110 },
      { file: "packages/daemon/src/daemon.ts", line: 4412 },
      { file: "packages/daemon/src/daemon.ts", line: 5277 },
      { file: "packages/daemon/src/runtime.ts", line: 53 },
      { file: "packages/daemon/src/runtime.ts", line: 57 },
      { file: "packages/daemon/src/runtime.ts", line: 77 },
      { file: "packages/daemon/src/runtime.ts", line: 84 },
      { file: "packages/daemon/src/runtime.ts", line: 94 },
      { file: "packages/daemon/src/runtime.ts", line: 96 },
      { file: "packages/daemon/src/runtime.ts", line: 179 },
      { file: "packages/daemon/src/shared.ts", line: 98 },
      { file: "apps/cli/src/components/UpdateNotifier.tsx", line: 62 },
      { file: "apps/cli/src/index.tsx", line: 135 },
      { file: "apps/cli/src/mcp-server/index.ts", line: 181 },
      { file: "apps/cli/src/mcp-server/index.ts", line: 218 },
      {
        file: "apps/www/src/app/api/webhooks/github/handle-app-mention.ts",
        line: 669,
      },
      {
        file: "apps/www/src/app/api/webhooks/github/route-feedback.ts",
        line: 113,
      },
      {
        file: "apps/www/src/app/api/webhooks/github/route-feedback.ts",
        line: 123,
      },
      { file: "apps/www/src/app/api/webhooks/github/route.ts", line: 195 },
      {
        file: "apps/www/src/app/api/webhooks/github/shadow-refresh.ts",
        line: 117,
      },
      {
        file: "apps/www/src/app/api/webhooks/github/shadow-refresh.ts",
        line: 155,
      },
      {
        file: "apps/www/src/app/api/webhooks/github/shadow-refresh.ts",
        line: 162,
      },
      {
        file: "apps/www/src/app/api/webhooks/github/shadow-refresh.ts",
        line: 175,
      },
      {
        file: "apps/www/src/app/api/webhooks/github/shadow-refresh.ts",
        line: 185,
      },
      {
        file: "apps/www/src/app/api/webhooks/github/shadow-refresh.ts",
        line: 195,
      },
      {
        file: "apps/www/src/app/api/webhooks/github/shadow-refresh.ts",
        line: 204,
      },
      {
        file: "apps/www/src/app/api/webhooks/github/shadow-refresh.ts",
        line: 208,
      },
      {
        file: "apps/www/src/app/api/webhooks/github/shadow-refresh.ts",
        line: 219,
      },
      {
        file: "apps/www/src/app/api/webhooks/github/shadow-refresh.ts",
        line: 222,
      },
      {
        file: "apps/www/src/app/api/webhooks/github/shadow-refresh.ts",
        line: 235,
      },
      { file: "apps/www/src/app/api/webhooks/github/utils.ts", line: 252 },
      { file: "apps/www/src/app/api/webhooks/github/utils.ts", line: 294 },
      { file: "apps/www/src/app/api/webhooks/github/utils.ts", line: 321 },
      { file: "apps/www/src/app/api/webhooks/linear/handlers.ts", line: 220 },
      { file: "apps/www/src/app/api/webhooks/linear/handlers.ts", line: 226 },
      { file: "apps/www/src/app/api/webhooks/linear/handlers.ts", line: 672 },
      { file: "apps/www/src/app/api/webhooks/linear/handlers.ts", line: 683 },
      {
        file: "apps/www/src/components/chat/ag-ui-messages-reducer.ts",
        line: 272,
      },
      {
        file: "apps/www/src/components/chat/ag-ui-messages-reducer.ts",
        line: 386,
      },
      {
        file: "apps/www/src/components/chat/ag-ui-messages-reducer.ts",
        line: 412,
      },
      {
        file: "apps/www/src/components/chat/ag-ui-messages-reducer.ts",
        line: 445,
      },
      {
        file: "apps/www/src/components/chat/ag-ui-messages-reducer.ts",
        line: 470,
      },
      {
        file: "apps/www/src/components/chat/ag-ui-messages-reducer.ts",
        line: 493,
      },
      {
        file: "apps/www/src/components/chat/ag-ui-messages-reducer.ts",
        line: 533,
      },
      {
        file: "apps/www/src/components/chat/ag-ui-messages-reducer.ts",
        line: 545,
      },
      {
        file: "apps/www/src/components/chat/ag-ui-messages-reducer.ts",
        line: 578,
      },
      {
        file: "apps/www/src/components/chat/db-messages-to-ag-ui.ts",
        line: 178,
      },
      { file: "apps/www/src/components/chat/toUIMessages.ts", line: 160 },
      { file: "apps/www/src/components/chat/toUIMessages.ts", line: 176 },
      { file: "apps/www/src/components/chat/toUIMessages.ts", line: 292 },
      { file: "packages/agent/src/utils.ts", line: 351 },
      { file: "packages/agent/src/utils.ts", line: 1005 },
      { file: "packages/daemon/src/acp-adapter.ts", line: 81 },
      { file: "packages/daemon/src/acp-adapter.ts", line: 128 },
      { file: "packages/daemon/src/acp-adapter.ts", line: 183 },
      { file: "packages/daemon/src/acp-adapter.ts", line: 202 },
      { file: "packages/daemon/src/acp-adapter.ts", line: 203 },
      { file: "packages/daemon/src/acp-adapter.ts", line: 212 },
      { file: "packages/daemon/src/acp-adapter.ts", line: 360 },
      { file: "packages/daemon/src/acp-adapter.ts", line: 372 },
      { file: "packages/daemon/src/acp-adapter.ts", line: 467 },
      { file: "packages/daemon/src/acp-adapter.ts", line: 538 },
      { file: "packages/daemon/src/acp-adapter.ts", line: 578 },
      { file: "packages/daemon/src/acp-adapter.ts", line: 702 },
      { file: "packages/daemon/src/acp-codex-adapter.ts", line: 37 },
      { file: "packages/daemon/src/acp-codex-adapter.ts", line: 57 },
      { file: "packages/daemon/src/acp-codex-adapter.ts", line: 65 },
      { file: "packages/daemon/src/acp-codex-adapter.ts", line: 77 },
      { file: "packages/daemon/src/acp-codex-adapter.ts", line: 83 },
      { file: "packages/daemon/src/acp-codex-adapter.ts", line: 87 },
      { file: "packages/daemon/src/acp-codex-adapter.ts", line: 87 },
      { file: "packages/daemon/src/acp-codex-adapter.ts", line: 90 },
      { file: "packages/daemon/src/acp-codex-adapter.ts", line: 111 },
      { file: "packages/daemon/src/acp-codex-adapter.ts", line: 120 },
      { file: "packages/daemon/src/acp-codex-adapter.ts", line: 188 },
      { file: "packages/daemon/src/acp-codex-adapter.ts", line: 193 },
      { file: "packages/daemon/src/acp-codex-adapter.ts", line: 204 },
      { file: "packages/daemon/src/claude.ts", line: 359 },
      { file: "packages/daemon/src/claude.ts", line: 360 },
      { file: "packages/daemon/src/claude.ts", line: 369 },
      { file: "packages/daemon/src/claude.ts", line: 374 },
      { file: "packages/daemon/src/claude.ts", line: 400 },
      { file: "packages/daemon/src/claude.ts", line: 403 },
      { file: "packages/daemon/src/claude.ts", line: 408 },
      { file: "packages/daemon/src/claude.ts", line: 410 },
      { file: "packages/daemon/src/claude.ts", line: 414 },
      { file: "packages/daemon/src/claude.ts", line: 429 },
      { file: "packages/daemon/src/claude.ts", line: 448 },
      { file: "packages/daemon/src/claude.ts", line: 475 },
      { file: "packages/daemon/src/claude.ts", line: 476 },
      { file: "packages/daemon/src/claude.ts", line: 479 },
      { file: "packages/daemon/src/claude.ts", line: 536 },
      { file: "packages/daemon/src/claude.ts", line: 538 },
      { file: "packages/daemon/src/claude.ts", line: 543 },
      { file: "packages/daemon/src/claude.ts", line: 545 },
      { file: "packages/daemon/src/claude.ts", line: 546 },
      { file: "packages/daemon/src/codex-app-server.ts", line: 482 },
      { file: "packages/daemon/src/codex-app-server.ts", line: 1270 },
      { file: "packages/daemon/src/codex.ts", line: 300 },
      { file: "packages/daemon/src/codex.ts", line: 420 },
      { file: "packages/daemon/src/codex.ts", line: 475 },
      { file: "packages/daemon/src/codex.ts", line: 563 },
      { file: "packages/daemon/src/codex.ts", line: 920 },
      { file: "packages/daemon/src/codex.ts", line: 925 },
      { file: "packages/daemon/src/codex.ts", line: 932 },
      { file: "packages/daemon/src/codex.ts", line: 959 },
      { file: "packages/daemon/src/codex.ts", line: 978 },
      { file: "packages/daemon/src/codex.ts", line: 981 },
      { file: "packages/daemon/src/codex.ts", line: 983 },
      { file: "packages/daemon/src/codex.ts", line: 1002 },
      { file: "packages/daemon/src/codex.ts", line: 1132 },
      { file: "packages/daemon/src/daemon.ts", line: 157 },
      { file: "packages/daemon/src/daemon.ts", line: 158 },
      { file: "packages/daemon/src/daemon.ts", line: 174 },
      { file: "packages/daemon/src/daemon.ts", line: 182 },
      { file: "packages/daemon/src/daemon.ts", line: 446 },
      { file: "packages/daemon/src/daemon.ts", line: 1323 },
      { file: "packages/daemon/src/daemon.ts", line: 1525 },
      { file: "packages/daemon/src/daemon.ts", line: 1624 },
      { file: "packages/daemon/src/daemon.ts", line: 1627 },
      { file: "packages/daemon/src/daemon.ts", line: 1628 },
      { file: "packages/daemon/src/daemon.ts", line: 1629 },
      { file: "packages/daemon/src/daemon.ts", line: 1675 },
      { file: "packages/daemon/src/daemon.ts", line: 1676 },
      { file: "packages/daemon/src/daemon.ts", line: 1677 },
      { file: "packages/daemon/src/daemon.ts", line: 1700 },
      { file: "packages/daemon/src/daemon.ts", line: 1701 },
      { file: "packages/daemon/src/daemon.ts", line: 1702 },
      { file: "packages/daemon/src/daemon.ts", line: 1724 },
      { file: "packages/daemon/src/daemon.ts", line: 1725 },
      { file: "packages/daemon/src/daemon.ts", line: 1726 },
      { file: "packages/daemon/src/daemon.ts", line: 2211 },
      { file: "packages/daemon/src/daemon.ts", line: 2286 },
      { file: "packages/daemon/src/daemon.ts", line: 2962 },
      { file: "packages/daemon/src/daemon.ts", line: 5198 },
      { file: "packages/daemon/src/index.ts", line: 102 },
      { file: "packages/daemon/src/index.ts", line: 111 },
      { file: "packages/daemon/src/index.ts", line: 112 },
      { file: "packages/daemon/src/index.ts", line: 113 },
      { file: "packages/daemon/src/index.ts", line: 115 },
      { file: "packages/daemon/src/opencode.ts", line: 86 },
      { file: "packages/daemon/src/opencode.ts", line: 188 },
      { file: "packages/daemon/src/opencode.ts", line: 216 },
      { file: "packages/daemon/src/opencode.ts", line: 243 },
      { file: "packages/daemon/src/runtime.ts", line: 47 },
      { file: "packages/daemon/src/runtime.ts", line: 51 },
      { file: "packages/daemon/src/runtime.ts", line: 71 },
      { file: "packages/daemon/src/runtime.ts", line: 78 },
      { file: "packages/daemon/src/runtime.ts", line: 88 },
      { file: "packages/daemon/src/runtime.ts", line: 90 },
      { file: "packages/daemon/src/shared.ts", line: 44 },
    ]),
  ],
};

export function runArchitectureLint(
  workspaceRoot: string,
  config: ArchitectureLintConfig = defaultConfig,
): Finding[] {
  const absoluteRoot = path.resolve(workspaceRoot);
  const files = collectTargetFiles(absoluteRoot, config);
  const allowlist = createAllowlistIndex(config.allowlist);
  const rawFindings = files.flatMap((file) =>
    checkFile(absoluteRoot, file, config),
  );
  const remainingAllowances = new Map(allowlist);
  const activeFindings: Finding[] = [];
  for (const finding of rawFindings) {
    const key = allowlistKey(finding);
    const allowance = remainingAllowances.get(key) ?? 0;
    if (allowance > 0) {
      remainingAllowances.set(key, allowance - 1);
      continue;
    }
    activeFindings.push(finding);
  }
  const staleAllowlistFindings: Finding[] = [];
  const liveDebtKeys = new Set(
    rawFindings.map((finding) => allowlistKey(finding)),
  );
  const reportedStaleKeys = new Set<string>();
  for (const entry of config.allowlist) {
    const key = allowlistKey(entry);
    if (liveDebtKeys.has(key) || reportedStaleKeys.has(key)) {
      continue;
    }
    if (!fs.existsSync(path.join(absoluteRoot, entry.file))) {
      continue;
    }
    reportedStaleKeys.add(key);
    staleAllowlistFindings.push({
      rule: "stale-allowlist-entry",
      file: entry.file,
      line: entry.line,
      message: `architecture-lint allowlist entry no longer matches live debt: ${entry.rule}`,
    });
  }
  return [...activeFindings, ...staleAllowlistFindings];
}

export function findWorkspaceRoot(startDirectory: string): string {
  let current = path.resolve(startDirectory);
  while (true) {
    if (fs.existsSync(path.join(current, "pnpm-workspace.yaml"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(startDirectory);
    }
    current = parent;
  }
}

function baselineUnsafeCastDebtAllowlist(
  entries: Array<Pick<AllowlistEntry, "file" | "line">>,
): AllowlistEntry[] {
  return entries.map((entry) => ({
    rule: "no-unsafe-runtime-boundary-casts",
    file: entry.file,
    line: entry.line,
    owner: "smooth-runtime-rewrite",
    reason:
      "existing direct assertion debt exposed when the guardrail began blocking all assertions in protected roots",
    deletionCriterion:
      "replace this assertion with schema-backed parsing, typed builders, or a narrow helper",
  }));
}

function baselineRuleLineDebtAllowlist(
  rule: RuleId,
  entries: Array<Pick<AllowlistEntry, "file" | "line">>,
): AllowlistEntry[] {
  return entries.map((entry) => ({
    rule,
    file: entry.file,
    line: entry.line,
    owner: "smooth-runtime-rewrite",
    reason: "existing architecture debt exposed when the guardrail was enabled",
    deletionCriterion:
      "remove after this exact import or switch debt is deleted or rewritten",
  }));
}

function collectTargetFiles(
  workspaceRoot: string,
  config: ArchitectureLintConfig,
): string[] {
  const candidates = new Set<string>();
  for (const entry of [
    ...config.legacyRuntimeImportRoots,
    ...config.unsafeCastRoots,
    ...config.exhaustiveSwitchFiles,
  ]) {
    const absoluteEntry = path.join(workspaceRoot, entry);
    if (!fs.existsSync(absoluteEntry)) {
      continue;
    }
    const stat = fs.statSync(absoluteEntry);
    if (stat.isDirectory()) {
      for (const file of collectSourceFiles(absoluteEntry)) {
        candidates.add(file);
      }
    } else if (isSourceFile(absoluteEntry)) {
      candidates.add(absoluteEntry);
    }
  }
  return [...candidates].sort();
}

function collectSourceFiles(directory: string): string[] {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (ignoredDirectories.has(entry.name)) {
      continue;
    }
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(absolutePath));
    } else if (
      entry.isFile() &&
      isSourceFile(absolutePath) &&
      !isTestSourceFile(absolutePath)
    ) {
      files.push(absolutePath);
    }
  }
  return files;
}

function checkFile(
  workspaceRoot: string,
  absoluteFile: string,
  config: ArchitectureLintConfig,
): Finding[] {
  const relativeFile = normalizePath(
    path.relative(workspaceRoot, absoluteFile),
  );
  const sourceText = fs.readFileSync(absoluteFile, "utf8");
  const sourceFile = ts.createSourceFile(
    absoluteFile,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForFile(absoluteFile),
  );
  const findings: Finding[] = [];
  visitSourceFile(sourceFile, (node) => {
    if (matchesAny(relativeFile, config.legacyRuntimeImportRoots)) {
      const specifier = getModuleSpecifier(node);
      if (specifier && specifier.includes(legacyRuntimeImportSegment)) {
        pushFinding(findings, {
          rule: "no-legacy-runtime-imports",
          file: relativeFile,
          line: lineOf(sourceFile, node),
          message: `legacy runtime import is blocked in rewrite-owned runtime paths: ${specifier}`,
        });
      }
    }
    if (matchesAny(relativeFile, config.unsafeCastRoots)) {
      const castText = getUnsafeCastText(sourceFile, node);
      if (castText) {
        pushFinding(findings, {
          rule: "no-unsafe-runtime-boundary-casts",
          file: relativeFile,
          line: lineOf(sourceFile, node),
          message: `unsafe runtime boundary cast is blocked: ${castText}`,
        });
      }
    }
    if (
      config.exhaustiveSwitchFiles.includes(relativeFile) &&
      ts.isSwitchStatement(node) &&
      !hasExhaustiveDefault(sourceFile, node)
    ) {
      pushFinding(findings, {
        rule: "require-exhaustive-switch",
        file: relativeFile,
        line: lineOf(sourceFile, node),
        message:
          "switch statements in canonical projection code need an exhaustive default guard",
      });
    }
  });
  return findings;
}

function pushFinding(findings: Finding[], finding: Finding): void {
  findings.push(finding);
}

function createAllowlistIndex(entries: AllowlistEntry[]): Map<string, number> {
  const index = new Map<string, number>();
  for (const entry of entries) {
    if (!entry.owner || !entry.reason || !entry.deletionCriterion) {
      throw new Error(
        `architecture-lint allowlist entry needs owner, reason, and deletionCriterion: ${entry.file}:${entry.line} ${entry.rule}`,
      );
    }
    const key = allowlistKey(entry);
    index.set(key, (index.get(key) ?? 0) + 1);
  }
  return index;
}

function allowlistKey(entry: Pick<Finding, "rule" | "file">): string {
  return `${entry.rule}:${entry.file}`;
}

function visitSourceFile(
  sourceFile: ts.SourceFile,
  visitor: (node: ts.Node) => void,
): void {
  function visit(node: ts.Node): void {
    visitor(node);
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

function getModuleSpecifier(node: ts.Node): string | null {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    const specifier = node.moduleSpecifier;
    if (specifier && ts.isStringLiteral(specifier)) {
      return specifier.text;
    }
  }
  if (
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword
  ) {
    const firstArgument = node.arguments.at(0);
    if (firstArgument && ts.isStringLiteralLike(firstArgument)) {
      return firstArgument.text;
    }
  }
  return null;
}

function getUnsafeCastText(
  sourceFile: ts.SourceFile,
  node: ts.Node,
): string | null {
  if (ts.isAsExpression(node)) {
    if (isNestedAssertionOperand(node)) {
      return null;
    }
    const normalized = normalizeNodeText(sourceFile, node);
    if (isLegacyUnsafeCast(normalized)) {
      return normalized;
    }
    if (isSafeAssertion(sourceFile, node)) {
      return null;
    }
    return normalized;
  }
  if (ts.isTypeAssertionExpression(node)) {
    const normalized = normalizeNodeText(sourceFile, node);
    if (isLegacyUnsafeCast(normalized)) {
      return normalized;
    }
    if (isSafeTypeAssertion(sourceFile, node)) {
      return null;
    }
    return normalized;
  }
  return null;
}

function isLegacyUnsafeCast(normalizedText: string): boolean {
  return (
    normalizedText.includes(" as any") ||
    normalizedText.includes(" as unknown as ") ||
    normalizedText.startsWith("<any>")
  );
}

function isNestedAssertionOperand(node: ts.AsExpression): boolean {
  return ts.isAsExpression(node.parent) && node.parent.expression === node;
}

function isSafeAssertion(
  sourceFile: ts.SourceFile,
  node: ts.AsExpression,
): boolean {
  return (
    isConstAssertion(sourceFile, node.type) ||
    isSafeLiteralAssertion(sourceFile, node.expression, node.type)
  );
}

function isSafeTypeAssertion(
  sourceFile: ts.SourceFile,
  node: ts.TypeAssertion,
): boolean {
  return (
    isConstAssertion(sourceFile, node.type) ||
    isSafeLiteralAssertion(sourceFile, node.expression, node.type)
  );
}

function isConstAssertion(
  sourceFile: ts.SourceFile,
  type: ts.TypeNode,
): boolean {
  return type.getText(sourceFile) === "const";
}

function isSafeLiteralAssertion(
  sourceFile: ts.SourceFile,
  expression: ts.Expression,
  type: ts.TypeNode,
): boolean {
  return (
    isPrimitiveLiteralExpression(expression) &&
    isPrimitiveLiteralType(sourceFile, type)
  );
}

function isPrimitiveLiteralExpression(expression: ts.Expression): boolean {
  return (
    ts.isStringLiteralLike(expression) ||
    ts.isNumericLiteral(expression) ||
    expression.kind === ts.SyntaxKind.TrueKeyword ||
    expression.kind === ts.SyntaxKind.FalseKeyword
  );
}

function isPrimitiveLiteralType(
  sourceFile: ts.SourceFile,
  type: ts.TypeNode,
): boolean {
  if (ts.isLiteralTypeNode(type)) {
    return true;
  }
  const text = type.getText(sourceFile);
  return text === "string" || text === "number" || text === "boolean";
}

function normalizeNodeText(sourceFile: ts.SourceFile, node: ts.Node): string {
  return node.getText(sourceFile).replace(/\s+/g, " ");
}

function hasExhaustiveDefault(
  sourceFile: ts.SourceFile,
  switchStatement: ts.SwitchStatement,
): boolean {
  for (const clause of switchStatement.caseBlock.clauses) {
    if (clause.kind !== ts.SyntaxKind.DefaultClause) {
      continue;
    }
    const text = clause.getText(sourceFile);
    return (
      text.includes("assertNever(") ||
      text.includes(": never") ||
      text.includes("_exhaustive")
    );
  }
  return false;
}

function isSourceFile(filePath: string): boolean {
  return sourceExtensions.has(path.extname(filePath));
}

function scriptKindForFile(filePath: string): ts.ScriptKind {
  const extension = path.extname(filePath);
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  return ts.ScriptKind.TS;
}

function isTestSourceFile(filePath: string): boolean {
  return /\.(test|spec)\.[cm]?[tj]sx?$/.test(filePath);
}

function matchesAny(relativeFile: string, roots: string[]): boolean {
  return roots.some((root) => isUnderPath(relativeFile, root));
}

function isUnderPath(relativeFile: string, root: string): boolean {
  const normalizedRoot = normalizePath(root);
  return (
    relativeFile === normalizedRoot ||
    relativeFile.startsWith(`${normalizedRoot}/`)
  );
}

function normalizePath(filePath: string): string {
  return filePath.split(path.sep).join(path.posix.sep);
}

function lineOf(sourceFile: ts.SourceFile, node: ts.Node): number {
  return (
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
  );
}

function formatFinding(finding: Finding): string {
  return `${finding.file}:${finding.line} ${finding.rule} ${finding.message}`;
}

export function formatFindings(findings: Finding[]): string {
  if (findings.length === 0) {
    return "architecture-lint: 0 findings";
  }
  return findings.map(formatFinding).join(os.EOL);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const workspaceRoot = findWorkspaceRoot(process.cwd());
  const findings = runArchitectureLint(workspaceRoot);
  console.log(formatFindings(findings));
  if (findings.length > 0) {
    process.exitCode = 1;
  }
}
