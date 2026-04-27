import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type ArchitectureLintConfig,
  defaultConfig,
  runArchitectureLint,
} from "./index";

let workspaceRoot = "";

beforeEach(() => {
  workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "architecture-lint-"));
});

afterEach(() => {
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

describe("architecture-lint", () => {
  it("blocks legacy runtime imports in configured rewrite-owned paths", () => {
    writeFile(
      "apps/www/src/agent/runtime/adapter.ts",
      legacyRuntimeImport("@/server-lib", "/v3/store"),
    );

    const findings = runArchitectureLint(workspaceRoot, testConfig());

    expect(findings).toEqual([
      expect.objectContaining({
        rule: "no-legacy-runtime-imports",
        file: "apps/www/src/agent/runtime/adapter.ts",
      }),
    ]);
  });

  it("covers live task data, UI, query, action, CLI command, and runtime legacy paths by default", () => {
    writeFile(
      "apps/www/src/app/(sidebar)/(task-list)/task/[threadId]/new-page.tsx",
      legacyRuntimeImport("@/components/patterns", "-plan-review-card"),
    );
    writeFile(
      "apps/www/src/app/api/ag-ui/[threadId]/new-route.ts",
      legacyRuntimeImport("@/server-lib", "/v3/store"),
    );
    writeFile(
      "apps/www/src/app/api/webhooks/github/new-handler.ts",
      legacyRuntimeImport("@terragon/shared", "/store/workflow-store"),
    );
    writeFile(
      "apps/www/src/components/chat/new-view.tsx",
      legacyRuntimeImport("@/components/patterns", "-plan-review-card"),
    );
    writeFile(
      "apps/www/src/components/promptbox/new-promptbox.tsx",
      legacyRuntimeImport("@/server-lib", "/v3/store"),
    );
    writeFile(
      "apps/www/src/components/thread-list/new-item.tsx",
      legacyRuntimeImport("@/lib", "-status"),
    );
    writeFile(
      "apps/www/src/hooks/new-hook.ts",
      legacyRuntimeImport("@/queries", "-status-queries"),
    );
    writeFile(
      "apps/www/src/queries/new-query.ts",
      legacyRuntimeImport(".", "-status-queries"),
    );
    writeFile(
      "apps/www/src/server-actions/new-action.ts",
      legacyRuntimeImport("@/server-lib", "/v3/store"),
    );
    writeFile(
      "apps/cli/src/commands/create-new.tsx",
      legacyRuntimeImport("@terragon/shared", "/store/workflow-store"),
    );

    const findings = runArchitectureLint(workspaceRoot, defaultConfig);

    expect(findings).toEqual([
      expect.objectContaining({
        rule: "no-legacy-runtime-imports",
        file: "apps/cli/src/commands/create-new.tsx",
      }),
      expect.objectContaining({
        rule: "no-legacy-runtime-imports",
        file: "apps/www/src/app/(sidebar)/(task-list)/task/[threadId]/new-page.tsx",
      }),
      expect.objectContaining({
        rule: "no-legacy-runtime-imports",
        file: "apps/www/src/app/api/ag-ui/[threadId]/new-route.ts",
      }),
      expect.objectContaining({
        rule: "no-legacy-runtime-imports",
        file: "apps/www/src/app/api/webhooks/github/new-handler.ts",
      }),
      expect.objectContaining({
        rule: "no-legacy-runtime-imports",
        file: "apps/www/src/components/chat/new-view.tsx",
      }),
      expect.objectContaining({
        rule: "no-legacy-runtime-imports",
        file: "apps/www/src/components/promptbox/new-promptbox.tsx",
      }),
      expect.objectContaining({
        rule: "no-legacy-runtime-imports",
        file: "apps/www/src/components/thread-list/new-item.tsx",
      }),
      expect.objectContaining({
        rule: "no-legacy-runtime-imports",
        file: "apps/www/src/hooks/new-hook.ts",
      }),
      expect.objectContaining({
        rule: "no-legacy-runtime-imports",
        file: "apps/www/src/queries/new-query.ts",
      }),
      expect.objectContaining({
        rule: "no-legacy-runtime-imports",
        file: "apps/www/src/server-actions/new-action.ts",
      }),
    ]);
  });

  it("allows legacy runtime imports outside configured rewrite-owned paths", () => {
    writeFile(
      "apps/www/src/server-lib/legacy.ts",
      legacyRuntimeImport("@/server-lib", "/v3/store"),
    );

    expect(runArchitectureLint(workspaceRoot, testConfig())).toEqual([]);
  });

  it("blocks unsafe boundary casts in configured paths", () => {
    writeFile(
      "apps/www/src/components/chat/thread-view-model/reducer.ts",
      "type ToolCallResultEvent = { toolCallId: string };\nexport const value = input as ToolCallResultEvent;\n",
    );

    const findings = runArchitectureLint(workspaceRoot, testConfig());

    expect(findings).toEqual([
      expect.objectContaining({
        rule: "no-unsafe-runtime-boundary-casts",
        file: "apps/www/src/components/chat/thread-view-model/reducer.ts",
      }),
    ]);
  });

  it("blocks structural and alias assertions in configured paths", () => {
    writeFile(
      "apps/www/src/components/chat/thread-view-model/reducer.ts",
      "type SomePayload = { id: string };\nexport const structural = input as { id: string };\nexport const record = input as Record<string, unknown>;\nexport const alias = input as SomePayload;\n",
    );

    const findings = runArchitectureLint(workspaceRoot, testConfig());

    expect(findings).toEqual([
      expect.objectContaining({
        rule: "no-unsafe-runtime-boundary-casts",
        file: "apps/www/src/components/chat/thread-view-model/reducer.ts",
        line: 2,
      }),
      expect.objectContaining({
        rule: "no-unsafe-runtime-boundary-casts",
        file: "apps/www/src/components/chat/thread-view-model/reducer.ts",
        line: 3,
      }),
      expect.objectContaining({
        rule: "no-unsafe-runtime-boundary-casts",
        file: "apps/www/src/components/chat/thread-view-model/reducer.ts",
        line: 4,
      }),
    ]);
  });

  it("blocks unknown double casts in configured paths", () => {
    writeFile(
      "apps/www/src/components/chat/thread-view-model/reducer.ts",
      "export const value = input as unknown as { id: string };\n",
    );

    const findings = runArchitectureLint(workspaceRoot, testConfig());

    expect(findings).toEqual([
      expect.objectContaining({
        rule: "no-unsafe-runtime-boundary-casts",
        file: "apps/www/src/components/chat/thread-view-model/reducer.ts",
      }),
    ]);
  });

  it("allows const assertions and primitive literal assertions", () => {
    writeFile(
      "apps/www/src/components/chat/thread-view-model/reducer.ts",
      "export const status = 'completed' as const;\nexport const retryCount = 1 as 1;\nexport const enabled = true as boolean;\n",
    );

    expect(runArchitectureLint(workspaceRoot, testConfig())).toEqual([]);
  });

  it("allows explicit legacy unsafe cast debt with owner, reason, and deletion criterion", () => {
    writeFile(
      "apps/www/src/components/chat/ag-ui-messages-reducer.ts",
      "export const value = input as unknown as { id: string };\n",
    );

    expect(
      runArchitectureLint(workspaceRoot, {
        legacyRuntimeImportRoots: [],
        exhaustiveSwitchFiles: [],
        unsafeCastRoots: [
          "apps/www/src/components/chat/ag-ui-messages-reducer.ts",
        ],
        allowlist: [
          {
            rule: "no-unsafe-runtime-boundary-casts",
            file: "apps/www/src/components/chat/ag-ui-messages-reducer.ts",
            line: 1,
            owner: "smooth-runtime-rewrite",
            reason: "fixture preserves explicit unsafe-cast debt",
            deletionCriterion: "remove when typed fixture boundary exists",
          },
        ],
      }),
    ).toEqual([]);
  });

  it("blocks angle-bracket assertions in ts files", () => {
    writeFile(
      "apps/www/src/components/chat/thread-view-model/reducer.ts",
      "type Payload = { id: string };\nexport const value = <Payload>input;\n",
    );

    const findings = runArchitectureLint(workspaceRoot, testConfig());

    expect(findings).toEqual([
      expect.objectContaining({
        rule: "no-unsafe-runtime-boundary-casts",
        file: "apps/www/src/components/chat/thread-view-model/reducer.ts",
        line: 2,
      }),
    ]);
  });

  it("rejects allowlist entries without debt metadata", () => {
    writeFile(
      "apps/www/src/components/chat/ag-ui-messages-reducer.ts",
      "export const value = input as unknown as { id: string };\n",
    );

    expect(() =>
      runArchitectureLint(workspaceRoot, {
        legacyRuntimeImportRoots: [],
        exhaustiveSwitchFiles: [],
        unsafeCastRoots: [
          "apps/www/src/components/chat/ag-ui-messages-reducer.ts",
        ],
        allowlist: [
          {
            rule: "no-unsafe-runtime-boundary-casts",
            file: "apps/www/src/components/chat/ag-ui-messages-reducer.ts",
            line: 1,
            owner: "",
            reason: "fixture preserves explicit unsafe-cast debt",
            deletionCriterion: "remove when typed fixture boundary exists",
          },
        ],
      }),
    ).toThrow("owner, reason, and deletionCriterion");
  });

  it("rejects stale allowlist entries that no longer match live debt", () => {
    writeFile(
      "apps/www/src/components/chat/ag-ui-messages-reducer.ts",
      "export const value = { id: 'typed' };\n",
    );

    const findings = runArchitectureLint(workspaceRoot, {
      legacyRuntimeImportRoots: [],
      exhaustiveSwitchFiles: [],
      unsafeCastRoots: [
        "apps/www/src/components/chat/ag-ui-messages-reducer.ts",
      ],
      allowlist: [
        {
          rule: "no-unsafe-runtime-boundary-casts",
          file: "apps/www/src/components/chat/ag-ui-messages-reducer.ts",
          line: 1,
          owner: "smooth-runtime-rewrite",
          reason: "fixture preserves explicit unsafe-cast debt",
          deletionCriterion: "remove when typed fixture boundary exists",
        },
      ],
    });

    expect(findings).toEqual([
      expect.objectContaining({
        rule: "stale-allowlist-entry",
        file: "apps/www/src/components/chat/ag-ui-messages-reducer.ts",
        line: 1,
      }),
    ]);
  });

  it("requires exhaustive switch guards in configured projection files", () => {
    writeFile(
      "packages/agent/src/ag-ui-mapper.ts",
      "export function map(value: 'a' | 'b'): number {\n  switch (value) {\n    case 'a':\n      return 1;\n    case 'b':\n      return 2;\n  }\n}\n",
    );

    const findings = runArchitectureLint(workspaceRoot, testConfig());

    expect(findings).toEqual([
      expect.objectContaining({
        rule: "require-exhaustive-switch",
        file: "packages/agent/src/ag-ui-mapper.ts",
      }),
    ]);
  });

  it("covers canonical projection files by default", () => {
    writeFile(
      "packages/shared/src/model/agent-event-log.ts",
      "export function map(value: 'a' | 'b'): number {\n  switch (value) {\n    case 'a':\n      return 1;\n    case 'b':\n      return 2;\n  }\n}\n",
    );
    writeFile(
      "apps/www/src/components/chat/ag-ui-messages-reducer.ts",
      "export function reduce(value: 'a' | 'b'): number {\n  switch (value) {\n    case 'a':\n      return 1;\n    case 'b':\n      return 2;\n  }\n}\n",
    );
    writeFile(
      "apps/www/src/components/chat/db-messages-to-ag-ui.ts",
      "export function hydrate(value: 'a' | 'b'): number {\n  switch (value) {\n    case 'a':\n      return 1;\n    case 'b':\n      return 2;\n  }\n}\n",
    );

    const findings = runArchitectureLint(workspaceRoot, defaultConfig).filter(
      (finding) => finding.rule === "require-exhaustive-switch",
    );

    expect(findings).toEqual([
      expect.objectContaining({
        rule: "require-exhaustive-switch",
        file: "apps/www/src/components/chat/db-messages-to-ag-ui.ts",
      }),
      expect.objectContaining({
        rule: "require-exhaustive-switch",
        file: "packages/shared/src/model/agent-event-log.ts",
      }),
    ]);
  });

  it("accepts exhaustive switch guards in configured projection files", () => {
    writeFile(
      "packages/agent/src/ag-ui-mapper.ts",
      "export function map(value: 'a' | 'b'): number {\n  switch (value) {\n    case 'a':\n      return 1;\n    case 'b':\n      return 2;\n    default: {\n      const _exhaustiveCheck: never = value;\n      return _exhaustiveCheck;\n    }\n  }\n}\n",
    );

    expect(runArchitectureLint(workspaceRoot, testConfig())).toEqual([]);
  });
});

function writeFile(relativePath: string, contents: string): void {
  const absolutePath = path.join(workspaceRoot, relativePath);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, contents);
}

function legacyRuntimeImport(prefix: string, suffix: string): string {
  const segment = ["delivery", "loop"].join("-");
  return `import { valueFromLegacyRuntime } from "${prefix}/${segment}${suffix}";
export const value = valueFromLegacyRuntime;
`;
}

function testConfig(): ArchitectureLintConfig {
  return {
    legacyRuntimeImportRoots: ["apps/www/src/agent/runtime"],
    unsafeCastRoots: ["apps/www/src/components/chat/thread-view-model"],
    exhaustiveSwitchFiles: ["packages/agent/src/ag-ui-mapper.ts"],
    allowlist: [],
  };
}
