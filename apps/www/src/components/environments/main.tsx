"use client";

import { useRealtimeUser } from "@/hooks/useRealtime";
import Link from "next/link";
import { Environment } from "@terragon/shared";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { EnvironmentVariablesEditor } from "@/components/environments/environment-variables-editor";
import { McpConfigEditor } from "@/components/environments/mcp-config-editor";
import { updateEnvironmentVariables } from "@/server-actions/environment-variables";
import { updateMcpConfig } from "@/server-actions/mcp-config";
import { toast } from "sonner";
import { usePageBreadcrumbs } from "@/hooks/usePageBreadcrumbs";
import { McpConfig } from "@terragon/sandbox/mcp-config";
import { Button } from "@/components/ui/button";
import { FileCog, Loader2, Package, RefreshCw, Trash2 } from "lucide-react";
import { CreateEnvironmentButton } from "@/components/environments/create-environment-button";
import { DeleteEnvironmentButton } from "@/components/environments/delete-environment-button";
import { useUnsavedChangesWarning } from "@/hooks/useUnsavedChangesWarning";
import { publicDocsUrl } from "@terragon/env/next-public";
import { usePageHeader } from "@/contexts/page-header";
import { Portal } from "@radix-ui/react-portal";
import { useServerActionMutation } from "@/queries/server-action-helpers";
import { unwrapResult } from "@/lib/server-actions";
import type { EnvironmentSnapshot } from "@terragon/shared/db/schema";
import type { SandboxSize } from "@terragon/types/sandbox";
import {
  buildEnvironmentSnapshot,
  deleteEnvironmentSnapshot,
  getSnapshotStatus,
} from "@/server-actions/environment-snapshot";

function EnvironmentBreadcrumb({ label }: { label: string | null }) {
  usePageBreadcrumbs([
    { label: "Environments", href: "/environments" },
    ...(label ? [{ label }] : []),
  ]);
  return null;
}

export function Environments({
  environments,
}: {
  environments: Environment[];
}) {
  const router = useRouter();
  const { headerActionContainer } = usePageHeader();
  usePageBreadcrumbs([{ label: "Environments" }]);
  useRealtimeUser({
    matches: (message) => !!message.data.environmentId,
    onMessage: () => router.refresh(),
  });

  return (
    <>
      <Portal container={headerActionContainer}>
        <CreateEnvironmentButton />
      </Portal>
      <div className="flex flex-col justify-start h-full w-full max-w-4xl gap-8">
        <div className="rounded-xl border border-hairline bg-canvas p-5">
          <h3 className="text-sm font-medium text-strong mb-1">
            About sandbox environments
          </h3>
          <p className="text-sm text-mid">
            Terragon runs in an isolated Linux sandbox with Node.js, Python,
            Git, and the usual development tooling.{" "}
            <Link
              href={`${publicDocsUrl()}/docs/configuration/environment-setup/sandbox`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-strong underline underline-offset-2 hover:no-underline"
            >
              Learn more
            </Link>
            .
          </p>
        </div>

        <section className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between border-b border-hairline pb-2">
            <h2 className="text-lg font-semibold text-strong">Global</h2>
            <Link
              className="text-sm text-strong underline underline-offset-2 hover:no-underline"
              href="/environments/global"
            >
              Manage
            </Link>
          </div>
          <p className="text-sm text-mid">
            Environment variables that apply to every repository.
          </p>
        </section>

        <section className="flex flex-col gap-3">
          <div className="border-b border-hairline pb-2">
            <h2 className="text-lg font-semibold text-strong">
              Repository-specific
            </h2>
            <p className="text-sm text-mid">
              {environments?.length === 0
                ? 'Click "Create Environment" to add one.'
                : "Per-repository variables, MCP servers, and setup scripts."}
            </p>
          </div>
          {environments && environments.length > 0 && (
            <ul className="flex flex-col rounded-xl border border-hairline overflow-hidden divide-y divide-hairline">
              {environments.map((environment) => (
                <li key={environment.id}>
                  <Link
                    href={`/environments/${environment.id}`}
                    className="flex items-center justify-between px-4 py-3 hover:bg-sunken transition-colors"
                  >
                    <span className="font-mono text-sm text-strong truncate">
                      {environment.repoFullName}
                    </span>
                    <span className="text-xs text-mid">Configure</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </>
  );
}

function EnvironmentVariablesSection({
  environmentId,
  environmentVariables,
  globalEnvironmentVariableKeys,
  onDirtyChange,
}: {
  environmentId: string;
  environmentVariables: Array<{ key: string; value: string }>;
  globalEnvironmentVariableKeys: string[];
  onDirtyChange: (isDirty: boolean) => void;
}) {
  const router = useRouter();
  const [envVars, setEnvVars] = useState(environmentVariables);
  const updateEnvironmentVariablesMutation = useServerActionMutation({
    mutationFn: updateEnvironmentVariables,
    onSuccess: (_, { variables }) => {
      setEnvVars(variables);
      onDirtyChange(false); // Reset dirty state after successful save
      toast.success("Environment variables saved successfully");
      router.refresh();
    },
  });
  return (
    <div className="flex flex-col gap-2 mt-6">
      <h2 className="text-base font-semibold text-strong">
        Environment Variables
      </h2>
      <div className="flex flex-col gap-2">
        <span className="text-xs text-mid">
          Variables exposed in your sandbox. Encrypted at rest and in transit.{" "}
          <Link
            href={`${publicDocsUrl()}/docs/configuration/environment-setup/environment-variables`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-strong underline underline-offset-2 hover:no-underline"
          >
            Learn more
          </Link>
          .
        </span>
        <EnvironmentVariablesEditor
          variables={envVars}
          globalEnvironmentVariableKeys={globalEnvironmentVariableKeys}
          onChange={async (variables) => {
            await updateEnvironmentVariablesMutation.mutateAsync({
              environmentId,
              variables,
            });
          }}
          onDirtyChange={onDirtyChange}
          disabled={updateEnvironmentVariablesMutation.isPending}
        />
      </div>
    </div>
  );
}

function SnapshotStatusBadge({
  status,
}: {
  status: EnvironmentSnapshot["status"];
}) {
  switch (status) {
    case "building":
      return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-info/10 text-info">
          <Loader2 className="h-3 w-3 animate-spin" />
          Building
        </span>
      );
    case "ready":
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-success/10 text-success">
          Ready
        </span>
      );
    case "failed":
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-error/10 text-error">
          Failed
        </span>
      );
    case "stale":
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-warning/10 text-warning">
          Stale
        </span>
      );
  }
}

function SnapshotSection({
  environmentId,
  initialSnapshots,
}: {
  environmentId: string;
  initialSnapshots: EnvironmentSnapshot[];
}) {
  const [snapshots, setSnapshots] =
    useState<EnvironmentSnapshot[]>(initialSnapshots);
  const [selectedSize, setSelectedSize] = useState<SandboxSize>("small");
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const router = useRouter();

  const currentSnapshot = snapshots.find(
    (s) => s.provider === "daytona" && s.size === selectedSize,
  );

  // Poll for status while building
  useEffect(() => {
    if (currentSnapshot?.status !== "building") {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
      return;
    }
    pollingRef.current = setInterval(async () => {
      try {
        const result = await getSnapshotStatus({
          environmentId,
          size: selectedSize,
        });
        const snap = unwrapResult(result);
        if (snap) {
          setSnapshots((prev) => {
            const idx = prev.findIndex(
              (s) => s.provider === "daytona" && s.size === selectedSize,
            );
            const updated = [...prev];
            if (idx >= 0) {
              updated[idx] = snap;
            } else {
              updated.push(snap);
            }
            return updated;
          });
          if (snap.status !== "building") {
            router.refresh();
          }
        }
      } catch {
        // Ignore polling errors
      }
    }, 5000);
    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current);
        pollingRef.current = null;
      }
    };
  }, [currentSnapshot?.status, environmentId, selectedSize, router]);

  const buildMutation = useServerActionMutation({
    mutationFn: buildEnvironmentSnapshot,
    onSuccess: () => {
      setSnapshots((prev) => {
        const entry: EnvironmentSnapshot = {
          provider: "daytona",
          size: selectedSize,
          snapshotName: "",
          status: "building",
          setupScriptHash: "",
          baseDockerfileHash: "",
          builtAt: new Date().toISOString(),
        };
        const idx = prev.findIndex(
          (s) => s.provider === "daytona" && s.size === selectedSize,
        );
        const updated = [...prev];
        if (idx >= 0) {
          updated[idx] = entry;
        } else {
          updated.push(entry);
        }
        return updated;
      });
      toast.success("Snapshot build started");
    },
  });

  const deleteMutation = useServerActionMutation({
    mutationFn: deleteEnvironmentSnapshot,
    onSuccess: () => {
      setSnapshots((prev) =>
        prev.filter(
          (s) => !(s.provider === "daytona" && s.size === selectedSize),
        ),
      );
      toast.success("Snapshot deleted");
      router.refresh();
    },
  });

  return (
    <div className="flex flex-col gap-2 mt-10">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-strong">
          Sandbox Snapshots
        </h2>
        <div className="flex items-center gap-2">
          <select
            value={selectedSize}
            onChange={(e) => setSelectedSize(e.target.value as SandboxSize)}
            className="text-xs rounded-full border border-hairline px-3 py-1 bg-canvas text-strong tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-coral/50"
          >
            <option value="small">Small (2 vCPU, 4 GB)</option>
            <option value="large">Large (4 vCPU, 8 GB)</option>
          </select>
        </div>
      </div>
      <span className="text-xs text-mid">
        A pre-built snapshot of your repo, dependencies, and setup script. New
        tasks start from the snapshot instead of cloning and setting up.
      </span>

      {!currentSnapshot && (
        <div className="rounded-xl border border-hairline bg-canvas p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Package className="h-4 w-4 text-mid" />
              <span className="text-sm text-mid">
                No snapshot built for{" "}
                <span className="tabular-nums">{selectedSize}</span> size.
              </span>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() =>
                buildMutation.mutate({
                  environmentId,
                  size: selectedSize,
                })
              }
              disabled={buildMutation.isPending}
            >
              {buildMutation.isPending ? (
                <Loader2 className="h-3 w-3 mr-1 animate-spin" />
              ) : (
                <Package className="h-3 w-3 mr-1" />
              )}
              Build Snapshot
            </Button>
          </div>
        </div>
      )}

      {currentSnapshot && (
        <div className="rounded-xl border border-hairline bg-canvas p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <SnapshotStatusBadge status={currentSnapshot.status} />
              {currentSnapshot.builtAt &&
                currentSnapshot.status !== "building" && (
                  <span className="text-xs text-mid tabular-nums">
                    Built{" "}
                    {new Date(currentSnapshot.builtAt).toLocaleDateString()}
                  </span>
                )}
            </div>
            <div className="flex items-center gap-2">
              {(currentSnapshot.status === "ready" ||
                currentSnapshot.status === "stale" ||
                currentSnapshot.status === "failed") && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    buildMutation.mutate({
                      environmentId,
                      size: selectedSize,
                    })
                  }
                  disabled={buildMutation.isPending}
                >
                  <RefreshCw className="h-3 w-3 mr-1" />
                  {currentSnapshot.status === "failed" ? "Retry" : "Rebuild"}
                </Button>
              )}
              {currentSnapshot.status !== "building" && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-error hover:text-error"
                  onClick={() =>
                    deleteMutation.mutate({
                      environmentId,
                      size: selectedSize,
                    })
                  }
                  disabled={deleteMutation.isPending}
                >
                  <Trash2 className="h-3 w-3 mr-1" />
                  Delete
                </Button>
              )}
            </div>
          </div>
          {currentSnapshot.status === "failed" && currentSnapshot.error && (
            <p className="text-xs text-error mt-2">{currentSnapshot.error}</p>
          )}
          {currentSnapshot.status === "stale" && (
            <p className="text-xs text-warning mt-2">
              Setup script changed since this snapshot was built. Rebuild
              recommended.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export function EnvironmentUI({
  environmentId,
  environment,
  environmentVariables,
  globalEnvironmentVariableKeys,
  mcpConfig,
  snapshots,
}: {
  environmentId: string;
  environment: Pick<Environment, "repoFullName">;
  environmentVariables: Array<{ key: string; value: string }>;
  globalEnvironmentVariableKeys: string[];
  mcpConfig?: McpConfig;
  snapshots?: EnvironmentSnapshot[];
}) {
  const router = useRouter();
  const [mcpConfigState, setMcpConfigState] = useState(
    mcpConfig || { mcpServers: {} },
  );
  const [envVarsDirty, setEnvVarsDirty] = useState(false);
  const [mcpConfigDirty, setMcpConfigDirty] = useState(false);
  const { headerActionContainer } = usePageHeader();

  const hasUnsavedChanges = envVarsDirty || mcpConfigDirty;

  // Use custom hook for navigation warnings
  useUnsavedChangesWarning(hasUnsavedChanges);

  useRealtimeUser({
    matches: useCallback(
      (args) => {
        return (
          args.type === "user" && args.data.environmentId === environmentId
        );
      },
      [environmentId],
    ),
    onMessage: useCallback(() => {
      router.refresh();
    }, [router]),
  });

  const updateMcpConfigMutation = useServerActionMutation({
    mutationFn: updateMcpConfig,
    onSuccess: (_, { mcpConfig }) => {
      setMcpConfigState(mcpConfig);
      setMcpConfigDirty(false); // Reset dirty state after successful save
      toast.success("MCP configuration saved successfully");
      router.refresh();
    },
  });

  if (!environment) {
    return null;
  }
  return (
    <div className="flex flex-col justify-start h-full w-full max-w-4xl">
      <Portal container={headerActionContainer}>
        <DeleteEnvironmentButton
          environmentId={environmentId}
          repoFullName={environment.repoFullName}
        />
      </Portal>
      <EnvironmentBreadcrumb label={environment.repoFullName} />
      <div className="flex flex-col gap-4 w-full pb-4">
        <EnvironmentVariablesSection
          environmentId={environmentId}
          environmentVariables={environmentVariables}
          globalEnvironmentVariableKeys={globalEnvironmentVariableKeys}
          onDirtyChange={setEnvVarsDirty}
        />
        <div className="flex flex-col gap-2 mt-10">
          <h2 className="text-base font-semibold text-strong">
            MCP Server Configuration
          </h2>
          <div className="flex flex-col gap-2">
            <span className="text-xs text-mid">
              Custom Model Context Protocol (MCP) servers exposed to Terragon.
              Per-agent format support is documented{" "}
              <Link
                href={`${publicDocsUrl()}/docs/configuration/mcp-setup`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-strong underline underline-offset-2 hover:no-underline"
              >
                in our docs
              </Link>
              .
            </span>
            <McpConfigEditor
              value={mcpConfigState}
              onChange={async (config) => {
                await updateMcpConfigMutation.mutateAsync({
                  environmentId,
                  mcpConfig: config,
                });
              }}
              onDirtyChange={setMcpConfigDirty}
              disabled={updateMcpConfigMutation.isPending}
            />
          </div>
        </div>

        <div className="flex flex-col gap-2 mt-10 mb-8">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-strong">
              Environment Setup
            </h2>
            <Link href={`/environments/${environmentId}/setup`}>
              <Button variant="outline" size="sm">
                <FileCog className="h-4 w-4 mr-1" />
                Edit Setup Script
              </Button>
            </Link>
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-xs text-mid">
              Commands that run when your environment starts. Either configure
              an environment-specific script in settings, or add a{" "}
              <code className="font-mono px-1.5 py-0.5 rounded bg-surface-dark text-on-dark text-[11px]">
                terragon-setup.sh
              </code>{" "}
              file at the repo root. Environment scripts take precedence.{" "}
              <Link
                href={`${publicDocsUrl()}/docs/configuration/environment-setup/setup-scripts`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-strong underline underline-offset-2 hover:no-underline"
              >
                Learn more
              </Link>
              .
            </span>
          </div>
          <div className="rounded-xl bg-surface-dark p-4">
            <p className="text-[11px] uppercase tracking-[0.06em] text-on-dark-soft mb-2">
              Example
            </p>
            <pre className="font-mono text-[13px] leading-[1.5] text-on-dark whitespace-pre">
              {`#!/bin/bash
npm install
pip install -r requirements.txt
./my-custom-setup.sh`}
            </pre>
          </div>
        </div>

        <SnapshotSection
          environmentId={environmentId}
          initialSnapshots={snapshots ?? []}
        />
      </div>
    </div>
  );
}

export function GlobalEnvironmentUI({
  environmentId,
  environmentVariables,
}: {
  environmentId: string;
  environmentVariables: Array<{ key: string; value: string }>;
}) {
  const [envVarsDirty, setEnvVarsDirty] = useState(false);
  const hasUnsavedChanges = envVarsDirty;
  useUnsavedChangesWarning(hasUnsavedChanges);

  return (
    <div className="flex flex-col justify-start h-full w-full max-w-4xl">
      <EnvironmentBreadcrumb label="Global" />
      <p className="text-sm text-mid">
        The global environment applies to all your repositories.
      </p>
      <EnvironmentVariablesSection
        environmentId={environmentId}
        environmentVariables={environmentVariables}
        globalEnvironmentVariableKeys={[]}
        onDirtyChange={setEnvVarsDirty}
      />
    </div>
  );
}
