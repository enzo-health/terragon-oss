"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { usePageBreadcrumbs } from "@/hooks/usePageBreadcrumbs";
import { type EnvironmentWithUser } from "@/server-actions/admin/environment";
import { deleteEnvironmentAndThreads } from "@/server-actions/admin/environment";
import { SingleEntityTable } from "./single-entity-table";
import { EntityIdInput } from "./entity-id-input";

export function AdminEnvironmentContent({
  environmentIdOrNull,
  environmentOrNull,
}: {
  environmentIdOrNull: string | null;
  environmentOrNull: EnvironmentWithUser | null;
}) {
  const router = useRouter();
  usePageBreadcrumbs([
    { label: "Admin", href: "/internal/admin" },
    { label: "Environments", href: "/internal/admin/environment" },
    ...(environmentIdOrNull ? [{ label: environmentIdOrNull }] : []),
  ]);

  return (
    <div className="flex flex-col justify-start h-full w-full">
      <div className="space-y-6">
        <EntityIdInput
          placeholder="Enter Environment ID or Thread ID..."
          onSubmit={(value) => {
            router.push(`/internal/admin/environment?id=${value}`);
          }}
        />

        {environmentIdOrNull && !environmentOrNull && (
          <p className="font-semibold text-error">Environment not found</p>
        )}
        {environmentOrNull && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <h2 className="text-base font-semibold">Environment Details</h2>
              <SingleEntityTable
                entity={environmentOrNull}
                rowKeys={[
                  "id",
                  "user",
                  "repoFullName",
                  "setupScript",
                  "createdAt",
                  "updatedAt",
                  "environmentVariables",
                  "mcpConfigEncrypted",
                ]}
                getLabel={(key) => {
                  const labelMap: Record<string, string> = {
                    environmentVariables: "Environment Variables",
                    mcpConfigEncrypted: "MCP Config",
                  };
                  return labelMap[key] ?? key;
                }}
                renderKey={(key) => {
                  if (key === "user") {
                    return {
                      type: "link",
                      href: `/internal/admin/user/${environmentOrNull.user.id}`,
                      label: environmentOrNull.user.name,
                    };
                  }
                  if (key === "setupScript") {
                    return environmentOrNull.setupScript
                      ? {
                          type: "json",
                          value: environmentOrNull.setupScript,
                          compact: true,
                        }
                      : "null";
                  }
                  if (key === "environmentVariables") {
                    return environmentOrNull.environmentVariables &&
                      environmentOrNull.environmentVariables.length > 0 ? (
                      <div className="space-y-2">
                        {environmentOrNull.environmentVariables.map(
                          (envVar, idx) => (
                            <div key={idx} className="flex items-center gap-2">
                              <span className="font-mono text-xs">
                                {envVar.key}
                              </span>
                              <span className="font-mono text-xs text-mid-text">
                                =
                              </span>
                              <span className="font-mono text-xs text-mid-text">
                                [ENCRYPTED]
                              </span>
                            </div>
                          ),
                        )}
                      </div>
                    ) : (
                      "None"
                    );
                  }
                  if (key === "mcpConfigEncrypted") {
                    return environmentOrNull.mcpConfigEncrypted ? (
                      <span className="text-muted-foreground">[ENCRYPTED]</span>
                    ) : (
                      "None"
                    );
                  }
                  return undefined;
                }}
              />
            </div>
            <AdminEnvironmentDangerZone environment={environmentOrNull} />
          </div>
        )}
      </div>
    </div>
  );
}

export function AdminEnvironmentIdOrThreadIdInput() {
  const router = useRouter();
  return (
    <EntityIdInput
      placeholder="Enter Environment ID or Thread ID..."
      onSubmit={(value) => {
        router.push(`/internal/admin/environment?id=${value}`);
      }}
    />
  );
}

function AdminEnvironmentDangerZone({
  environment,
}: {
  environment: EnvironmentWithUser;
}) {
  const router = useRouter();
  const [isDeleting, setIsDeleting] = useState(false);

  return (
    <div className="mt-4 rounded-[1.25rem] p-6 bg-error/5 border border-error/30">
      <h3 className="text-sm font-semibold text-error">Danger Zone</h3>
      <p className="text-sm text-muted-foreground mt-1">
        This will permanently delete this environment and all associated threads
        for user {environment.user.name} in repo{" "}
        <span className="font-mono text-xs">{environment.repoFullName}</span>.
        This action cannot be undone.
      </p>
      <div className="mt-3">
        <Button
          variant="destructive"
          disabled={isDeleting}
          className="rounded-full"
          onClick={async () => {
            const ok = window.confirm(
              `Are you sure you want to DELETE environment ${environment.id} (repo ${environment.repoFullName}) and ALL its threads? This cannot be undone.`,
            );
            if (!ok) return;
            setIsDeleting(true);
            try {
              const res = await deleteEnvironmentAndThreads({
                environmentId: environment.id,
              });
              alert(
                `Deleted environment ${res.environmentId} and ${res.deletedThreadCount} thread(s).`,
              );
              router.push(`/internal/admin/environment`);
              router.refresh();
            } catch (e: any) {
              alert(e?.message ?? "Failed to delete environment");
            } finally {
              setIsDeleting(false);
            }
          }}
        >
          {isDeleting ? "Deleting..." : "Delete environment and threads"}
        </Button>
      </div>
    </div>
  );
}
