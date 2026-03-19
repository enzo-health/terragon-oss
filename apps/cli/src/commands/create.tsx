import React, { useState, useEffect } from "react";
import { Box, Text } from "ink";
import Spinner from "ink-spinner";
import { useMutation } from "@tanstack/react-query";
import { apiClient } from "../utils/apiClient.js";
import { useGitInfo } from "../hooks/useGitInfo.js";
import type { AIModelExternal } from "@terragon/agent/types";

interface CreateCommandProps {
  message: string;
  repo?: string;
  branch?: string;
  createNewBranch?: boolean;
  mode?: "plan" | "execute";
  model?: AIModelExternal;
}

export function resolveCreateTaskBaseBranchName({
  branch,
  currentBranch,
  createNewBranch,
}: {
  branch?: string;
  currentBranch?: string | null;
  createNewBranch: boolean;
}): string | undefined {
  const explicitBranch = branch?.trim();
  if (explicitBranch) {
    return explicitBranch;
  }

  if (!createNewBranch) {
    return currentBranch?.trim() || undefined;
  }

  return undefined;
}

export function CreateCommand({
  message,
  repo,
  branch,
  createNewBranch = true,
  mode = "execute",
  model,
}: CreateCommandProps) {
  const [error, setError] = useState<string | null>(null);
  const gitInfo = useGitInfo();

  const createMutation = useMutation({
    mutationFn: async () => {
      const finalRepo = repo || gitInfo.repo;
      if (!finalRepo) {
        throw new Error(
          "No repository specified and could not detect from current directory",
        );
      }

      const repoBaseBranchName = resolveCreateTaskBaseBranchName({
        branch,
        currentBranch: gitInfo.branch,
        createNewBranch,
      });

      // Normalize mode just in case
      const normalizedMode: "plan" | "execute" =
        mode === "plan" ? "plan" : "execute";

      const result = await apiClient.threads.create({
        message,
        githubRepoFullName: finalRepo,
        repoBaseBranchName,
        createNewBranch,
        mode: normalizedMode,
        model,
      });
      return result;
    },
    onError: (error) => {
      console.error("Error creating thread:", error);
      setError(error.message || "Failed to create thread");
    },
  });

  useEffect(() => {
    if (!gitInfo.isLoading) {
      createMutation.mutate();
    }
  }, [gitInfo.isLoading]);

  if (gitInfo.isLoading || createMutation.isPending) {
    return (
      <Box flexDirection="column">
        <Text>
          <Spinner type="dots" />{" "}
          {gitInfo.isLoading
            ? "Detecting repository..."
            : "Creating new task..."}
        </Text>
      </Box>
    );
  }

  if (createMutation.isError || error) {
    return (
      <Box flexDirection="column">
        <Text color="red">❌ Error: {error || "Failed to create thread"}</Text>
      </Box>
    );
  }

  if (createMutation.isSuccess && createMutation.data) {
    const finalRepo = repo || gitInfo.repo;
    return (
      <Box flexDirection="column">
        <Text color="green">✓ Task created successfully!</Text>
        <Text>Repository: {finalRepo}</Text>
        <Text>Thread ID: {createMutation.data.threadId}</Text>
        {createMutation.data.branchName && (
          <Text>Branch: {createMutation.data.branchName}</Text>
        )}
        <Text dimColor>
          Visit https://www.terragonlabs.com/task/{createMutation.data.threadId}{" "}
          to view your task
        </Text>
      </Box>
    );
  }

  return null;
}
