"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Plus,
  Github,
  Search,
  Loader2,
  Check,
  ExternalLink,
} from "lucide-react";
import { createEnvironment } from "@/server-actions/create-environment";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { useUserReposQuery } from "@/queries/user-repo-queries";
import { getEnvironments } from "@/server-actions/get-environments";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { getGHAppInstallUrl } from "@/lib/gh-app-url";
import {
  useServerActionMutation,
  useServerActionQuery,
} from "@/queries/server-action-helpers";

export function CreateEnvironmentButton() {
  const router = useRouter();
  const [isOpen, setIsOpen] = useState(false);
  const [selectedRepo, setSelectedRepo] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const { data: repoData, isLoading: isLoadingRepos } = useUserReposQuery({
    enabled: isOpen,
  });

  const { data: environments, isLoading: isLoadingEnvironments } =
    useServerActionQuery({
      queryKey: ["environments"],
      queryFn: getEnvironments,
      staleTime: 10 * 60 * 1000, // 10 minutes
      enabled: isOpen,
    });

  const createEnvironmentMutation = useServerActionMutation({
    mutationFn: createEnvironment,
    onSuccess: (environment, { repoFullName }) => {
      toast.success(`Environment created for ${repoFullName}`);
      setIsOpen(false);
      router.push(`/environments/${environment.id}`);
      router.refresh();
    },
  });

  const environmentsByRepo = new Map(
    environments?.map((env) => [env.repoFullName, env]) || [],
  );

  const repos = repoData?.repos || [];
  const filteredRepos = repos.filter((repo) =>
    repo.full_name.toLowerCase().includes(searchQuery.toLowerCase()),
  );

  const handleCreateEnvironment = async () => {
    if (!selectedRepo) {
      toast.error("Please select a repository");
      return;
    }
    await createEnvironmentMutation.mutateAsync({
      repoFullName: selectedRepo,
    });
  };

  return (
    <>
      <Button
        onClick={() => {
          setIsOpen(true);
          setSelectedRepo(null);
          setSearchQuery("");
        }}
        variant="default"
        size="sm"
      >
        <Plus className="h-4 w-4 mr-1" />
        Create Environment
      </Button>

      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Create Environment</DialogTitle>
            <DialogDescription>
              Select a GitHub repository to create an environment for. This will
              allow you to configure environment variables, MCP servers, and
              setup scripts for this repository.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-mid pointer-events-none" />
              <Input
                type="text"
                placeholder="Search repositories…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10"
              />
            </div>

            <div className="rounded-xl border border-hairline overflow-hidden flex flex-col">
              <div
                className="overflow-y-auto"
                style={{
                  minHeight: "56px",
                  maxHeight: `${56 * 6}px`,
                }}
              >
                {isLoadingRepos || isLoadingEnvironments ? (
                  <div className="min-h-[56px] flex items-center justify-center p-4">
                    <div className="flex flex-col items-center gap-2">
                      <Loader2 className="h-6 w-6 animate-spin text-mid" />
                      <span className="text-sm text-mid">
                        Loading repositories…
                      </span>
                    </div>
                  </div>
                ) : filteredRepos.length === 0 ? (
                  <div className="min-h-[56px] flex items-center justify-center p-4">
                    <div className="text-center text-sm text-mid">
                      {searchQuery
                        ? "No repositories match that search."
                        : "No repositories found."}
                    </div>
                  </div>
                ) : (
                  <div className="divide-y divide-hairline">
                    {filteredRepos.map((repo) => {
                      const hasEnvironment = environmentsByRepo.has(
                        repo.full_name,
                      );
                      const isSelected =
                        selectedRepo === repo.full_name && !hasEnvironment;
                      return (
                        <button
                          key={repo.full_name}
                          onClick={() => {
                            if (!hasEnvironment) {
                              setSelectedRepo(repo.full_name);
                            }
                          }}
                          disabled={hasEnvironment}
                          className={cn(
                            "w-full px-4 py-3 text-left transition-colors flex items-center gap-3",
                            hasEnvironment
                              ? "opacity-50 cursor-not-allowed"
                              : "hover:bg-sunken",
                            isSelected && "bg-sunken",
                          )}
                        >
                          <Github className="h-4 w-4 text-mid shrink-0" />
                          <div className="min-w-0 flex-1">
                            <div className="font-mono text-sm text-strong truncate">
                              {repo.full_name}
                            </div>
                          </div>
                          {hasEnvironment ? (
                            <span className="text-xs text-mid">Configured</span>
                          ) : (
                            isSelected && (
                              <Check className="h-4 w-4 text-coral" />
                            )
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>

            <div className="text-sm text-mid pt-1">
              Don't see one of your repositories?{" "}
              <button
                type="button"
                onClick={() => {
                  window.open(getGHAppInstallUrl(), "_blank");
                }}
                className="text-strong underline underline-offset-2 hover:no-underline transition-colors inline-flex items-center gap-1"
              >
                Manage repository access
                <ExternalLink className="h-3 w-3" />
              </button>
            </div>

            <div className="flex justify-end gap-3">
              <Button
                variant="outline"
                onClick={() => setIsOpen(false)}
                disabled={createEnvironmentMutation.isPending}
              >
                Cancel
              </Button>
              <Button
                onClick={handleCreateEnvironment}
                disabled={!selectedRepo || createEnvironmentMutation.isPending}
              >
                {createEnvironmentMutation.isPending
                  ? "Creating…"
                  : "Create Environment"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
