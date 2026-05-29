"use client";

import { PRStatusPill } from "@/components/pr-status-pill";
import { usePageBreadcrumbs } from "@/hooks/usePageBreadcrumbs";
import { type GithubPRForAdmin } from "@/server-actions/admin/github-pr";
import { Button } from "@/components/ui/button";
import { refreshGitHubPR } from "@/server-actions/admin/github";
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { SingleEntityTable } from "./single-entity-table";
import Link from "next/link";

export function AdminGithubPRContent({
  repoFullName,
  prNumber,
  prOrNull,
}: {
  repoFullName: string;
  prNumber: string;
  prOrNull: GithubPRForAdmin | null;
}) {
  const { refresh } = useRouter();
  const [isRefreshing, setIsRefreshing] = useState(false);

  usePageBreadcrumbs([
    { label: "Admin", href: "/internal/admin" },
    { label: "GitHub", href: "/internal/admin/github" },
  ]);

  return (
    <div className="flex flex-col justify-start h-full w-full">
      <div className="space-y-6">
        {!prOrNull && (
          <p className="font-bold text-[var(--error)]">GitHub PR not found</p>
        )}
        {prOrNull && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <h2 className="text-md font-semibold underline">
                  {`${repoFullName} #${prNumber}`}
                </h2>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={isRefreshing}
                  onClick={async () => {
                    setIsRefreshing(true);
                    try {
                      await refreshGitHubPR({
                        prNumber: prOrNull.number,
                        repoFullName: prOrNull.repoFullName,
                      });
                      refresh();
                      setIsRefreshing(false);
                    } catch (error) {
                      setIsRefreshing(false);
                      throw error;
                    }
                  }}
                >
                  {isRefreshing ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    "Refresh"
                  )}
                </Button>
              </div>
              <SingleEntityTable
                entity={prOrNull}
                rowKeys={[
                  "id",
                  "repoFullName",
                  "number",
                  "status",
                  "baseRef",
                  "mergeableState",
                  "checksStatus",
                  "updatedAt",
                ]}
                renderKey={(key) => {
                  if (key === "repoFullName") {
                    return (
                      <div className="flex items-center gap-2">
                        {prOrNull.repoFullName}
                        <Link
                          className="underline text-sm"
                          href={`https://github.com/${prOrNull.repoFullName}/pull/${prOrNull.number}`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          (View on GitHub)
                        </Link>
                      </div>
                    );
                  }
                  if (key === "number") {
                    return prOrNull.status ? (
                      <div className="flex items-center gap-2">
                        <span className="font-mono tabular-nums">
                          #{prOrNull.number}
                        </span>
                        <PRStatusPill
                          repoFullName={prOrNull.repoFullName}
                          prNumber={prOrNull.number}
                          status={prOrNull.status}
                          checksStatus={prOrNull.checksStatus}
                        />
                      </div>
                    ) : (
                      `#${prOrNull.number}`
                    );
                  }
                  return undefined;
                }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
