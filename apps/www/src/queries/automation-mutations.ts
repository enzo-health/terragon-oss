import {
  createAutomation,
  deleteAutomation,
  enableOrDisableAutomation,
  runAutomation,
  runIssueAutomation,
  runPullRequestAutomation,
  updateAutomation,
} from "@/server-actions/automations";
import { threadQueryKeys } from "./thread-queries";
import { automationQueryKeys } from "./automation-queries";
import { Automation, AutomationInsert } from "@leo/shared";
import { toast } from "sonner";
import { ServerActionResult } from "@/lib/server-actions";
import { useServerActionMutation } from "./server-action-helpers";
import { useQueryClient } from "@tanstack/react-query";

export function useCreateAutomationMutation() {
  const queryClient = useQueryClient();
  return useServerActionMutation({
    mutationFn: createAutomation,
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: automationQueryKeys.list(),
      });
    },
  });
}

export function useDeleteAutomationMutation() {
  const queryClient = useQueryClient();
  return useServerActionMutation({
    mutationFn: deleteAutomation,
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: automationQueryKeys.list(),
      });
    },
  });
}

export function useRunAutomationMutation() {
  const queryClient = useQueryClient();
  return useServerActionMutation({
    mutationFn: runAutomation,
    onSuccess: (_, automationId) => {
      queryClient.invalidateQueries({
        queryKey: automationQueryKeys.list(),
      });
      queryClient.invalidateQueries({
        queryKey: automationQueryKeys.detail(automationId),
      });
      // Invalidate thread queries to reflect new threads created by automation
      queryClient.invalidateQueries({
        queryKey: threadQueryKeys.list(null),
      });
      toast.success("Automation started");
    },
  });
}

//  Generic hook for automation mutations with optimistic updates
function useAutomationMutation<TVariables extends { automationId: string }>({
  mutationFn,
  onSuccess,
  updateAutomation,
}: {
  mutationFn: (variables: TVariables) => Promise<ServerActionResult>;
  onSuccess?: ({ variables }: { variables: TVariables }) => void;
  updateAutomation: (
    automation: Automation,
    variables: TVariables,
  ) => Automation;
}) {
  const queryClient = useQueryClient();
  return useServerActionMutation({
    mutationFn,
    onMutate: async (variables) => {
      const { automationId } = variables;
      // Cancel any outgoing refetches
      await queryClient.cancelQueries({ queryKey: ["automations"] });
      // Helper to update a automation
      const updateAutomationWrapper = (automation: Automation) => {
        if (automation.id !== automationId) return automation;
        return updateAutomation(automation, variables);
      };
      // Update automation detail query
      queryClient.setQueryData<Automation>(
        automationQueryKeys.detail(automationId),
        (old) => (old ? updateAutomationWrapper(old) : old),
      );
      // Update automations list
      queryClient.setQueriesData<Automation[]>(
        { queryKey: automationQueryKeys.list() },
        (old) => {
          if (!old) return old;
          return old.map(updateAutomationWrapper);
        },
      );
    },
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: automationQueryKeys.list() });
      queryClient.invalidateQueries({
        queryKey: automationQueryKeys.detail(variables.automationId),
      });
      onSuccess?.({ variables });
    },
    onError: (_, variables) => {
      // On error, invalidate all automation queries to refetch fresh data
      queryClient.invalidateQueries({ queryKey: automationQueryKeys.list() });
      queryClient.invalidateQueries({
        queryKey: automationQueryKeys.detail(variables.automationId),
      });
    },
    onSettled: (_, __, variables) => {
      queryClient.invalidateQueries({ queryKey: automationQueryKeys.list() });
      queryClient.invalidateQueries({
        queryKey: automationQueryKeys.detail(variables.automationId),
      });
    },
  });
}

export function useEnableOrDisableAutomationMutation() {
  return useAutomationMutation<{ automationId: string; enabled: boolean }>({
    mutationFn: enableOrDisableAutomation,
    updateAutomation: (automation, { enabled }) => ({ ...automation, enabled }),
    onSuccess: ({ variables }) => {
      toast.success(`Automation ${variables.enabled ? "enabled" : "disabled"}`);
    },
  });
}

export function useEditAutomationMutation() {
  return useAutomationMutation<{
    automationId: string;
    updates: Omit<
      AutomationInsert,
      "userId" | "createdAt" | "updatedAt" | "lastRunAt" | "runCount"
    >;
  }>({
    mutationFn: updateAutomation,
    onSuccess: () => toast.success("Automation updated"),
    updateAutomation: (automation, { updates }) => ({
      ...automation,
      ...updates,
    }),
  });
}

export function useRunPullRequestAutomationMutation() {
  const queryClient = useQueryClient();
  return useServerActionMutation({
    mutationFn: runPullRequestAutomation,
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: automationQueryKeys.list() });
      queryClient.invalidateQueries({
        queryKey: automationQueryKeys.detail(variables.automationId),
      });
      // Invalidate thread queries to reflect new threads created by PR automation
      queryClient.invalidateQueries({ queryKey: threadQueryKeys.list(null) });
      toast.success("Pull request automation started");
    },
  });
}

export function useRunIssueAutomationMutation() {
  const queryClient = useQueryClient();
  return useServerActionMutation({
    mutationFn: runIssueAutomation,
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: automationQueryKeys.list() });
      queryClient.invalidateQueries({
        queryKey: automationQueryKeys.detail(variables.automationId),
      });
      toast.success("Issue automation started");
    },
  });
}
