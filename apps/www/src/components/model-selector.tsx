"use client";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { memo, useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import type { AIAgent, AIModel, SelectedAIModels } from "@terragon/agent/types";
import type { SetSelectedModel } from "@/hooks/use-selected-model";
import {
  getModelDisplayName,
  getAgentModelGroups,
  modelToAgent,
  sortByAgents,
  type AgentModelGroup,
} from "@terragon/agent/utils";
import { useAtomValue } from "jotai";
import { useAgentsToDisplay, userSettingsAtom } from "@/atoms/user";
import React from "react";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import {
  Drawer,
  DrawerContent,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import { Check, SettingsIcon } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { AgentIcon } from "@/components/chat/agent-icon";
import { useFeatureFlag } from "@/hooks/use-feature-flag";
import { AGENT_VERSION } from "@terragon/agent/versions";

function MultiAgentModeToggle({
  isMultiAgentMode,
  setIsMultiAgentMode,
  className,
}: {
  isMultiAgentMode: boolean;
  setIsMultiAgentMode: (isMultiAgentMode: boolean) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-2", className)}>
      <label
        htmlFor="multi-agent-toggle"
        className="text-xs font-medium cursor-pointer select-none"
      >
        Multi-Agent Mode
      </label>
      <Switch
        id="multi-agent-toggle"
        checked={isMultiAgentMode}
        onCheckedChange={(checked) => {
          setIsMultiAgentMode(!!checked);
        }}
      />
    </div>
  );
}

function ModelSelectorInner({
  className,
  isMultiAgentMode,
  setIsMultiAgentMode,
  supportsMultiAgentPromptSubmission,
  selectedModel,
  selectedModels,
  setSelectedModel,
  forcedAgent,
  forcedAgentVersion,
}: {
  className?: string;
  isMultiAgentMode: boolean;
  setIsMultiAgentMode: (isMultiAgentMode: boolean) => void;
  supportsMultiAgentPromptSubmission: boolean;
  selectedModel: AIModel | undefined;
  selectedModels: SelectedAIModels;
  setSelectedModel: SetSelectedModel;
  forcedAgent: AIAgent | null;
  forcedAgentVersion: number | null;
}) {
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [isSelectorOpen, setIsSelectorOpen] = useState(false);
  const openCodeOpenAIAnthropicModel = useFeatureFlag(
    "opencodeOpenAIAnthropicModelOption",
  );
  const openCodeGemini3ProModel = useFeatureFlag(
    "opencodeGemini3ProModelOption",
  );
  const currentlySelectedModels = useMemo(() => {
    const models: AIModel[] = [];
    if (selectedModel) {
      models.push(selectedModel);
    }
    if (isMultiAgentMode) {
      models.push(...(Object.keys(selectedModels) as AIModel[]));
    }
    return models;
  }, [selectedModel, selectedModels, isMultiAgentMode]);

  // Compute the agents to display based on current selection
  const agentsToDisplay = useAgentsToDisplay({
    forcedAgent,
    selectedModels: currentlySelectedModels,
  });
  // Use the stable ref value during the component's lifetime
  const userSettings = useAtomValue(userSettingsAtom);
  const agentGroupsRaw = useMemo(() => {
    return agentsToDisplay
      .map((agent) =>
        getAgentModelGroups({
          agent,
          agentModelPreferences: userSettings?.agentModelPreferences ?? {},
          selectedModels: currentlySelectedModels,
          options: {
            agentVersion: forcedAgentVersion ?? AGENT_VERSION,
            enableOpenRouterOpenAIAnthropicModel: openCodeOpenAIAnthropicModel,
            enableOpencodeGemini3ProModelOption: openCodeGemini3ProModel,
          },
        }),
      )
      .filter((group) => group.models.length > 0);
  }, [
    forcedAgentVersion,
    openCodeOpenAIAnthropicModel,
    openCodeGemini3ProModel,
    agentsToDisplay,
    userSettings?.agentModelPreferences,
    currentlySelectedModels,
  ]);

  // Don't re-compute the agent/model groups until we re-open the selector.
  const [agentGroups, setAgentGroups] = useState(agentGroupsRaw);
  useEffect(() => {
    if (!isSelectorOpen && !isDrawerOpen) {
      setAgentGroups(agentGroupsRaw);
    }
  }, [agentGroupsRaw, isDrawerOpen, isSelectorOpen]);

  const triggerLabel = useMemo(() => {
    const defaultLabel = (
      <span className="block min-w-0 truncate text-left">Select Model</span>
    );

    if (isMultiAgentMode) {
      const selectedModelArr = Object.keys(selectedModels) as AIModel[];
      if (selectedModelArr.length === 0) {
        return defaultLabel;
      }
      if (selectedModelArr.length > 1) {
        // Get unique agents from selected models
        const agentsArr = selectedModelArr.map((model) => modelToAgent(model));
        agentsArr.sort(sortByAgents);
        return (
          <div className="flex min-w-0 flex-1 items-center space-x-0.5 sm:-space-x-1.5">
            {agentsArr.map((agent, idx) => (
              <AgentIcon key={idx} agent={agent} sessionId={null} />
            ))}
          </div>
        );
      }
    }

    const selectedModelOrNull = isMultiAgentMode
      ? (Object.keys(selectedModels)[0] as AIModel)
      : selectedModel;
    if (!selectedModelOrNull) {
      return defaultLabel;
    }
    const selectedModelAgent = modelToAgent(selectedModelOrNull)!;
    const { fullName } = getModelDisplayName(selectedModelOrNull);
    return (
      <div className="flex min-w-0 flex-1 items-center gap-1">
        {!forcedAgent && (
          <AgentIcon agent={selectedModelAgent} sessionId={null} />
        )}
        <span className="block min-w-0 truncate text-left" title={fullName}>
          {fullName}
        </span>
      </div>
    );
  }, [isMultiAgentMode, selectedModels, selectedModel, forcedAgent]);

  const triggerClassName = cn(
    "w-fit max-w-full min-w-0 px-1",
    "border-none shadow-none hover:bg-transparent text-muted-foreground hover:text-foreground gap-0.5 dark:bg-transparent dark:hover:bg-transparent",
    className,
  );

  return (
    <>
      <Drawer
        open={isDrawerOpen}
        onOpenChange={setIsDrawerOpen}
        dismissible
        modal
      >
        <DrawerTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className={cn(triggerClassName, "flex sm:hidden")}
            aria-expanded={isDrawerOpen}
            aria-haspopup="dialog"
          >
            {triggerLabel}
          </Button>
        </DrawerTrigger>
        <DrawerContent>
          <DrawerHeader className="text-left pb-2 flex-row justify-between">
            <DrawerTitle>Select Model</DrawerTitle>
            {supportsMultiAgentPromptSubmission && (
              <MultiAgentModeToggle
                isMultiAgentMode={isMultiAgentMode}
                setIsMultiAgentMode={setIsMultiAgentMode}
              />
            )}
          </DrawerHeader>
          <div className="flex-1 overflow-y-auto px-4 pb-6 space-y-4">
            {agentGroups.map((group) => {
              return (
                <div key={group.agent} className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    {group.label}
                  </p>
                  <div className="space-y-1">
                    {group.models.map((model) => {
                      const isSelected = isMultiAgentMode
                        ? !!selectedModels[model]
                        : selectedModel === model;
                      if (isMultiAgentMode) {
                        const checkboxId = `model-selector-checkbox-${model}`;
                        return (
                          <label
                            key={model}
                            htmlFor={checkboxId}
                            className="flex w-full gap-2 items-start justify-start rounded-md border border-transparent px-3 py-2 text-left text-sm transition-colors"
                          >
                            <Checkbox
                              id={checkboxId}
                              checked={isSelected}
                              onClick={() => {
                                setSelectedModel({ model, action: "toggle" });
                              }}
                            />
                            <div className="flex flex-col gap-1">
                              <ModelDisplay model={model} />
                            </div>
                          </label>
                        );
                      }
                      return (
                        <button
                          key={model}
                          type="button"
                          onClick={() => {
                            setSelectedModel({ model });
                            setIsDrawerOpen(false);
                          }}
                          className="flex w-full gap-2 items-start justify-start rounded-md border border-transparent px-3 py-2 text-left text-sm transition-colors"
                        >
                          <Check
                            className={cn(
                              "size-4",
                              isSelected ? "opacity-100" : "opacity-0",
                            )}
                          />
                          <div className="flex flex-col gap-1">
                            <ModelDisplay model={model} />
                          </div>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="p-4 border-t">
            <AgentConfigButton forcedAgent={forcedAgent} />
          </div>
        </DrawerContent>
      </Drawer>
      <Select
        value={selectedModel ?? undefined}
        open={isSelectorOpen}
        onOpenChange={setIsSelectorOpen}
        onValueChange={(value) => {
          if (!isMultiAgentMode) {
            setSelectedModel({ model: value as AIModel });
          }
        }}
      >
        <SelectTrigger
          className={cn(triggerClassName, "hidden sm:flex")}
          size="sm"
        >
          <SelectValue asChild placeholder="Select a Model">
            {/* There's a bug in radix related to SSR so we use asChild here and render the value manually */}
            {typeof triggerLabel === "string" ? (
              <span>{triggerLabel}</span>
            ) : (
              triggerLabel
            )}
          </SelectValue>
        </SelectTrigger>
        <SelectContent className="w-fit">
          {supportsMultiAgentPromptSubmission && (
            <MultiAgentModeToggle
              isMultiAgentMode={isMultiAgentMode}
              setIsMultiAgentMode={setIsMultiAgentMode}
              className="flex items-center gap-2 justify-between px-2 py-2 border-b w-[180px] sm:w-full"
            />
          )}
          {agentGroups.map((group, index) => (
            <React.Fragment key={group.agent}>
              <ModelGroup
                group={group}
                isMultiAgentMode={isMultiAgentMode}
                selectedModels={selectedModels}
                setSelectedModel={setSelectedModel}
              />
              {index < agentGroups.length - 1 && <SelectSeparator />}
            </React.Fragment>
          ))}
          <SelectSeparator />
          <div className="px-2 py-1.5">
            <AgentConfigButton forcedAgent={forcedAgent} />
          </div>
        </SelectContent>
      </Select>
    </>
  );
}

function AgentConfigButton({ forcedAgent }: { forcedAgent: AIAgent | null }) {
  return (
    <Link
      href="/settings/agent#available-agents-and-models"
      className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
    >
      <SettingsIcon className="size-4" />
      {forcedAgent ? "Configure Models" : "Configure Agents & Models"}
    </Link>
  );
}

function ModelGroup({
  group,
  isMultiAgentMode,
  selectedModels,
  setSelectedModel,
}: {
  group: AgentModelGroup;
  isMultiAgentMode: boolean;
  selectedModels: SelectedAIModels;
  setSelectedModel: ({
    model,
    action,
  }: {
    model: AIModel;
    action?: "toggle";
  }) => void;
}) {
  return (
    <SelectGroup>
      <SelectLabel>{group.label}</SelectLabel>
      {group.models.map((model: AIModel) => {
        const isSelected = isMultiAgentMode && !!selectedModels[model];
        if (isMultiAgentMode) {
          return (
            <div
              key={model}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setSelectedModel({ model, action: "toggle" });
              }}
              className={cn(
                "relative flex w-full cursor-pointer select-none items-center rounded-sm py-1.5 px-2 text-sm outline-none transition-colors",
                "hover:bg-accent hover:text-accent-foreground",
              )}
            >
              <Checkbox checked={!!isSelected} className="mr-2" />
              <div className="flex flex-col items-start w-full">
                <ModelDisplay model={model} />
              </div>
            </div>
          );
        }

        return (
          <SelectItem key={model} value={model}>
            <ModelDisplay model={model} />
          </SelectItem>
        );
      })}
    </SelectGroup>
  );
}

function ModelDisplay({ model }: { model: AIModel }) {
  const { mainName, subName } = getModelDisplayName(model);
  return (
    <span className="flex items-baseline gap-1">
      <span className="text-xs text-foreground/90">{mainName}</span>
      {subName && (
        <span className="text-xs text-muted-foreground/60">{subName}</span>
      )}
    </span>
  );
}

export const ModelSelector = memo(ModelSelectorInner);
