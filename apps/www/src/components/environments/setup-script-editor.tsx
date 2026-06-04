"use client";

import { useState, useEffect, useRef } from "react";
import { Environment } from "@terragon/shared";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "sonner";
import { usePageBreadcrumbs } from "@/hooks/usePageBreadcrumbs";
import {
  Loader2,
  Play,
  RefreshCw,
  X,
  Save,
  FileCode2,
  Square,
} from "lucide-react";
import { SetupScriptOutput } from "@/components/environments/setup-script-output";
import { useQueryClient } from "@tanstack/react-query";
import {
  updateEnvironmentSetupScript,
  getEnvironmentSetupScript,
} from "@/server-actions/environment-setup-script";
import { useSetupScript } from "@/hooks/use-setup-script";
import {
  useServerActionMutation,
  useServerActionQuery,
} from "@/queries/server-action-helpers";

function SetupScriptBreadcrumb({ environment }: { environment: Environment }) {
  usePageBreadcrumbs([
    { label: "Environments", href: "/environments" },
    {
      label: environment.repoFullName,
      href: `/environments/${environment.id}`,
    },
    { label: "Setup Script" },
  ]);
  return null;
}

const defaultScript = `#!/bin/bash
# terragon-setup.sh - Custom setup script for your Terragon environment
# This script runs when your sandbox environment starts

# Example: Install dependencies
# npm install

# Example: Run database migrations
# npm run db:migrate

# Example: Set up environment
# cp .env.example .env

# Example: Add binary to path
# echo "export PATH=$PATH:/path/to/binary" >> ~/.bashrc

echo "Setup complete!"
`;

type ScriptSource = "environment" | "repo" | "new";

export function SetupScriptEditor({
  environmentId,
  environment,
}: {
  environmentId: string;
  environment: Environment;
}) {
  const queryClient = useQueryClient();
  const { data: scriptData, isLoading } = useServerActionQuery({
    queryKey: ["setup-script", environmentId],
    queryFn: async () => {
      return await getEnvironmentSetupScript({
        environmentId,
      });
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
  });

  const textAreaRef = useRef<HTMLTextAreaElement>(null);
  const [scriptValue, setScriptValue] = useState<string>("");
  const [scriptSource, setScriptSource] = useState<ScriptSource>("new");
  const [savedEnvironmentScript, setSavedEnvironmentScript] = useState<
    string | null
  >(null);

  const savedContent = scriptData?.content;
  const savedSource = scriptData?.type;

  useEffect(() => {
    if (scriptSource !== savedSource) {
      setScriptSource(savedSource ?? "new");
    }
    if (savedSource === "environment") {
      setSavedEnvironmentScript(savedContent ?? null);
    } else {
      setSavedEnvironmentScript(null);
    }
    if (typeof savedContent === "string") {
      setScriptValue(savedContent);
    } else {
      setScriptValue(defaultScript);
    }
  }, [savedSource, savedContent, scriptSource]);

  const saveToEnvironmentMutation = useServerActionMutation({
    mutationFn: async (scriptToSave: string | null) => {
      return await updateEnvironmentSetupScript({
        environmentId,
        setupScript: scriptToSave,
      });
    },
    onSuccess: (_, scriptToSave) => {
      toast.success(
        scriptToSave
          ? "Setup script saved to environment"
          : "Environment setup script removed",
      );
      setSavedEnvironmentScript(scriptToSave);
      setScriptSource("environment");
      // Invalidate the query to reload
      queryClient.invalidateQueries({
        queryKey: ["setup-script", environmentId],
      });
    },
  });

  const handleSaveToEnvironment = () => {
    saveToEnvironmentMutation.mutate(scriptValue);
  };

  const handleRemoveFromEnvironment = () => {
    if (
      confirm(
        "Are you sure you want to remove the environment setup script? The repository script will be used instead.",
      )
    ) {
      saveToEnvironmentMutation.mutate(null);
    }
  };

  const { status, execute, outputs, isRunning, stop } = useSetupScript({
    environmentId,
  });

  const handleResetScript = () => {
    setScriptValue(savedContent ?? defaultScript);
    textAreaRef.current?.focus();
  };

  const handleRun = () => {
    execute(scriptValue);
  };

  const hasChanges = scriptValue !== savedContent;
  const hasEnvironmentScript = typeof savedEnvironmentScript === "string";
  const isSaving = saveToEnvironmentMutation.isPending;
  const hasChangesFromSaved =
    hasEnvironmentScript && scriptValue !== savedEnvironmentScript;

  const canRemove = !isLoading && !isRunning && !isSaving;
  const canReset =
    !isLoading &&
    !isRunning &&
    ((scriptSource === "new" && scriptValue !== defaultScript) ||
      (scriptSource !== "new" && scriptValue.trim() !== ""));
  const canSave =
    !isLoading &&
    !isSaving &&
    !isRunning &&
    scriptValue.trim() !== "" &&
    (hasChanges || hasChangesFromSaved);
  const canRun = !isLoading && !isRunning && scriptValue.trim() !== "";

  return (
    <div className="flex flex-col justify-start h-full w-full max-w-4xl">
      <SetupScriptBreadcrumb environment={environment} />

      <div className="flex flex-col gap-4 w-full pb-4">
        <div className="flex items-start justify-between">
          <div className="flex flex-col gap-1">
            <h2 className="text-base font-semibold text-strong">
              Setup script editor
            </h2>
            <p className="text-sm text-mid">
              {scriptSource === "environment"
                ? "Environment-specific script (overrides the repository script)."
                : scriptSource === "repo"
                  ? "Using terragon-setup.sh from the repository."
                  : "Create a custom setup script for this environment."}
            </p>
          </div>

          <div className="flex gap-2">
            {hasEnvironmentScript && (
              <Button
                onClick={handleRemoveFromEnvironment}
                variant="outline"
                size="sm"
                disabled={!canRemove}
              >
                <X className="h-4 w-4 mr-1" />
                Remove
              </Button>
            )}
            {hasChanges && (
              <Button
                onClick={handleResetScript}
                variant="outline"
                size="sm"
                disabled={!canReset}
              >
                <RefreshCw className="h-4 w-4 mr-1" />
                Reset
              </Button>
            )}
            <Button
              onClick={handleSaveToEnvironment}
              size="sm"
              variant="outline"
              disabled={!canSave}
            >
              {isSaving ? (
                <>
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  Saving…
                </>
              ) : (
                <>
                  <Save className="h-4 w-4 mr-1" />
                  Save
                </>
              )}
            </Button>
            <Button
              onClick={handleRun}
              size="sm"
              variant="outline"
              disabled={!canRun}
            >
              {isRunning ? (
                <>
                  <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                  Running…
                </>
              ) : (
                <>
                  <Play className="h-4 w-4 mr-1" />
                  Test
                </>
              )}
            </Button>
          </div>
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center h-64 rounded-xl bg-surface-dark">
            <Loader2 className="h-6 w-6 animate-spin text-on-dark-soft" />
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <code className="font-mono text-[13px] text-mid">
                terragon-setup.sh
              </code>
              <div className="flex items-center gap-2">
                {scriptSource === "environment" && (
                  <span className="inline-flex items-center gap-1 text-xs bg-info/10 text-info px-2.5 py-0.5 rounded-full">
                    <FileCode2 className="h-3 w-3" />
                    Environment
                  </span>
                )}
                {scriptSource === "repo" && (
                  <span className="inline-flex items-center gap-1 text-xs bg-info/10 text-info px-2.5 py-0.5 rounded-full">
                    <FileCode2 className="h-3 w-3" />
                    Repository
                  </span>
                )}
                {hasChanges && (
                  <span className="text-xs text-mid">Modified</span>
                )}
              </div>
            </div>
            <Textarea
              ref={textAreaRef}
              value={scriptValue}
              onChange={(e) => setScriptValue(e.target.value)}
              placeholder="Enter your setup script here…"
              className="font-mono text-[13px] leading-[1.5] min-h-[400px] resize-y rounded-xl border-0 ring-0 bg-surface-dark text-on-dark caret-coral placeholder:text-on-dark-soft focus-visible:ring-2 focus-visible:ring-coral/50"
              disabled={isRunning}
            />
          </div>
        )}

        {(status !== "idle" || outputs.length > 0) && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-strong">Output</h3>
              {isRunning && (
                <Button onClick={stop} variant="outline" size="sm">
                  <Square className="h-4 w-4 mr-1" />
                  Stop
                </Button>
              )}
            </div>
            <SetupScriptOutput isRunning={isRunning} outputs={outputs} />
          </div>
        )}

        <div className="rounded-xl border border-hairline bg-canvas p-4">
          <p className="text-sm text-mid">
            <strong className="text-strong font-medium">Tip:</strong> To test
            what the agent will see in their environment, use{" "}
            <code className="font-mono px-1.5 py-0.5 rounded bg-surface-dark text-on-dark text-[11px]">
              bash -lc 'command'
            </code>{" "}
            in your script. This runs commands with a login shell, loading the
            same environment variables and configurations that the agent uses
            (e.g.{" "}
            <code className="font-mono px-1.5 py-0.5 rounded bg-surface-dark text-on-dark text-[11px]">
              bash -lc 'go version'
            </code>
            ).
          </p>
          <div className="my-4 h-px bg-hairline" />
          <p className="text-sm text-mid mb-2">Setup script priority:</p>
          <ul className="text-sm text-mid space-y-1 list-disc list-inside">
            <li>
              <strong className="text-strong font-medium">
                Environment script:
              </strong>{" "}
              if you save a script to this environment, it overrides any
              repository script.
            </li>
            <li>
              <strong className="text-strong font-medium">
                Repository script:
              </strong>{" "}
              the terragon-setup.sh file on your repository’s main branch (used
              when no environment script exists).
            </li>
            <li>
              Use Test to run the script in a fresh sandbox without saving.
            </li>
            <li>Save stores the script for this environment only.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
