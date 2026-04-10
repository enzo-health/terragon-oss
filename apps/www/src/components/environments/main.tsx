"use client";

import { useRealtimeUser } from "@/hooks/useRealtime";
import Link from "next/link";
import { Environment } from "@leo/shared";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { EnvironmentVariablesEditor } from "@/components/environments/environment-variables-editor";
import { McpConfigEditor } from "@/components/environments/mcp-config-editor";
import { updateEnvironmentVariables } from "@/server-actions/environment-variables";
import { updateMcpConfig } from "@/server-actions/mcp-config";
import { toast } from "sonner";
import { usePageBreadcrumbs } from "@/hooks/usePageBreadcrumbs";
import { McpConfig } from "@leo/sandbox/mcp-config";
import { Button } from "@/components/ui/button";
import { FileCog, Loader2, Package, RefreshCw, Trash2 } from "lucide-react";
import { CreateEnvironmentButton } from "@/components/environments/create-environment-button";
import { DeleteEnvironmentButton } from "@/components/environments/delete-environment-button";
import { useUnsavedChangesWarning } from "@/hooks/useUnsavedChangesWarning";
import { publicDocsUrl } from "@leo/env/next-public";
import { usePageHeader } from "@/contexts/page-header";
import { Portal } from "@radix-ui/react-portal";
import { useServerActionMutation } from "@/queries/server-action-helpers";
import { unwrapResult } from "@/lib/server-actions";
import type { EnvironmentSnapshot } from "@leo/shared/db/schema";
import type { SandboxSize } from "@leo/types/sandbox";
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
      <div className="flex flex-col justify-start h-full w-full max-w-4xl">
        <div className="mb-6 p-4 bg-muted/50 rounded-lg border">
          <h3 className="text-sm font-medium text-muted-foreground mb-2">
            About Sandbox Environments
          </h3>
          <p className="text-sm text-muted-foreground">
            Leo runs in an isolated Linux environment with full development
            capabilities. Each sandbox includes Node.js, Python, Git, and common
            development tools.
            <br />
            <br />
            <Link
              href={`${publicDocsUrl()}/docs/configuration/environment-setup/sandbox`}
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:no-underline"
            >
              Learn more about the sandbox environment
            </Link>
          </p>
        </div>
        <div className="space-y-2 pb-6 mb-4">
          <div className="border-b pb-2">
            <h2 className="text-lg font-semibold">Global</h2>
            <p className="text-sm text-muted-foreground">
              Manage environment variables that apply to all your repositories.
            </p>
          </div>
          <Link className="underline" href="/environments/global">
            Manage
          </Link>
        </div>
        <div className="space-y-2 pb-6">
          <div className="border-b pb-2">
            <h2 className="text-lg font-semibold">Repository Specific</h2>
            {environments?.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Click "Create Environment" to get started
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                Manage environment variables and MCP servers for specific
                repositories.
              </p>
            )}
          </div>
          <div className="flex flex-col gap-4 w-full">
            {environments?.map((environment) => (
              <Link
                className="underline"
                href={`/environments/${environment.id}`}
                key={environment.id}
              >
                {environment.repoFullName}
              </Link>
            ))}
          </div>
        </div>
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
      <h2 className="text-base font-medium text-muted-foreground">
        Environment Variables
      </h2>
      <div className="flex flex-col gap-2">
        <span className="text-xs text-muted-foreground">
          Configure environment variables that will be available in your sandbox
          environments. All environment variables are encrypted at rest and in
          transit for optimal security.{" "}
          <Link
            href={`${publicDocsUrl()}/docs/configuration/environment-setup/environment-variables`}
            target="_blank"
            rel="noopener noreferrer"
            className="underline hover:no-underline"
          >
            Learn more about environment variables
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
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
          <Loader2 className="h-3 w-3 animate-spin" />
          Building
        </span>
      );
    case "ready":
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400">
          Ready
        </span>
      );
    case "failed":
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
          Failed
        </span>
      );
    case "stale":
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400">
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
        <h2 className="text-base font-medium text-muted-foreground">
          Sandbox Snapshots
        </h2>
        <div className="flex items-center gap-2">
          <select
            value={selectedSize}
            onChange={(e) => setSelectedSize(e.target.value as SandboxSize)}
            className="text-xs border rounded px-2 py-1 bg-background"
          >
            <option value="small">Small (2 vCPU, 4GB)</option>
            <option value="large">Large (4 vCPU, 8GB)</option>
          </select>
        </div>
      </div>
      <span className="text-xs text-muted-foreground">
        Build a pre-configured snapshot that includes your repo, dependencies,
        and setup script. New tasks will start from this snapshot, skipping
        clone and setup entirely.
      </span>

      {!currentSnapshot && (
        <div className="border rounded-lg p-4 bg-muted/30">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Package className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm text-muted-foreground">
                No snapshot built for {selectedSize} size
              </span>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="text-xs"
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
        <div className="border rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <SnapshotStatusBadge status={currentSnapshot.status} />
              {currentSnapshot.builtAt &&
                currentSnapshot.status !== "building" && (
                  <span className="text-xs text-muted-foreground">
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
                  className="text-xs"
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
                  className="text-xs text-destructive hover:text-destructive"
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
            <p className="text-xs text-destructive mt-2">
              {currentSnapshot.error}
            </p>
          )}
          {currentSnapshot.status === "stale" && (
            <p className="text-xs text-yellow-600 dark:text-yellow-400 mt-2">
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
          <h2 className="text-base font-medium text-muted-foreground">
            MCP Server Configuration
          </h2>
          <div className="flex flex-col gap-2">
            <span className="text-xs text-muted-foreground">
              Configure custom Model Context Protocol ("MCP") servers that will
              be available to Leo. Learn more about which formats are supported
              with each agent{" "}
              <Link
                href={`${publicDocsUrl()}/docs/configuration/mcp-setup`}
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:no-underline"
              >
                in our documentation
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
            <h2 className="text-base font-medium text-muted-foreground">
              Environment Setup
            </h2>
            <Link href={`/environments/${environmentId}/setup`}>
              <Button variant="outline" size="sm" className="text-xs">
                <FileCog className="h-4 w-4 mr-1" />
                Edit Setup Script
              </Button>
            </Link>
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-xs text-muted-foreground">
              Configure custom setup commands that run when your environment
              starts. You can either configure an environment-specific script in
              the settings or add a{" "}
              <code className="bg-muted px-1 py-0.5 rounded text-xs">
                leo-setup.sh
              </code>{" "}
              file to your repository. Environment scripts take precedence over
              repository scripts.{" "}
              <Link
                href={`${publicDocsUrl()}/docs/configuration/environment-setup/setup-scripts`}
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:no-underline"
              >
                Learn more about setup scripts
              </Link>
              .
            </span>
          </div>
          <div className="bg-muted/50 p-3 rounded-md">
            <p className="text-xs text-muted-foreground mb-2">Example:</p>
            <code className="text-xs text-foreground block">
              #!/bin/bash
              <br />
              npm install
              <br />
              pip install -r requirements.txt
              <br />
              ./my-custom-setup.sh
            </code>
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
      <p>The global environment applies to all your repositories.</p>
      <EnvironmentVariablesSection
        environmentId={environmentId}
        environmentVariables={environmentVariables}
        globalEnvironmentVariableKeys={[]}
        onDirtyChange={setEnvVarsDirty}
      />
    </div>
  );
}
