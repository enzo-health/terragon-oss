"use client";

import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectList,
  SelectPopup,
  SelectSeparator,
  SelectTrigger,
} from "@/components/ai/select";
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
import { AGENT_VERSION } from "@terragon/agent/versions";

const optionValue = (value: unknown): string | undefined =>
  typeof value === "object" && value !== null && "value" in value
    ? String((value as { value: unknown }).value)
    : (value as string | undefined);

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

  const agentsToDisplay = useAgentsToDisplay({
    forcedAgent,
    selectedModels: currentlySelectedModels,
  });
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
          },
        }),
      )
      .filter((group) => group.models.length > 0);
  }, [
    forcedAgentVersion,
    agentsToDisplay,
    userSettings?.agentModelPreferences,
    currentlySelectedModels,
  ]);

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
    "h-8 w-fit max-w-full min-w-0 rounded-md px-1.5",
    "border-none shadow-none text-mid gap-0.5 hover:bg-muted hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground dark:bg-transparent",
    className,
  );

  const nauvalTriggerClassName = cn(
    "h-8 w-auto max-w-full min-w-0 rounded-md px-1.5 gap-1 text-muted-foreground",
    "hover:not-[[data-disabled]]:bg-muted hover:text-foreground",
    "data-[popup-open]:bg-muted data-[popup-open]:text-foreground",
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
                  <p className="text-[12px] font-medium text-mid uppercase tracking-[0.13em]">
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
                            className="flex w-full gap-2 items-start justify-start rounded-md border border-transparent px-3 py-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
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
                          className="flex w-full gap-2 items-start justify-start rounded-md border border-transparent px-3 py-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground"
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
        isItemEqualToValue={(a: unknown, b: unknown) =>
          optionValue(a) === optionValue(b)
        }
        onValueChange={(value: unknown) => {
          if (!isMultiAgentMode) {
            setSelectedModel({ model: optionValue(value) as AIModel });
          }
        }}
      >
        <SelectTrigger
          variant="plain"
          className={cn(nauvalTriggerClassName, "hidden sm:flex")}
        >
          {typeof triggerLabel === "string" ? (
            <span>{triggerLabel}</span>
          ) : (
            triggerLabel
          )}
        </SelectTrigger>
        <SelectPopup side="top" className="w-fit">
          {supportsMultiAgentPromptSubmission && (
            <MultiAgentModeToggle
              isMultiAgentMode={isMultiAgentMode}
              setIsMultiAgentMode={setIsMultiAgentMode}
              className="flex items-center gap-2 justify-between px-2 py-2 border-b w-[180px] sm:w-full"
            />
          )}
          <SelectList>
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
          </SelectList>
          <SelectSeparator />
          <div className="px-2 py-1.5">
            <AgentConfigButton forcedAgent={forcedAgent} />
          </div>
        </SelectPopup>
      </Select>
    </>
  );
}

function AgentConfigButton({ forcedAgent }: { forcedAgent: AIAgent | null }) {
  return (
    <Link
      href="/settings/agent#available-agents-and-models"
      className="flex items-center gap-2 text-xs text-mid hover:text-strong transition-colors"
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
      <SelectGroupLabel>{group.label}</SelectGroupLabel>
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
      <span className="text-xs text-strong">{mainName}</span>
      {subName && <span className="text-xs text-mid">{subName}</span>}
    </span>
  );
}

export const ModelSelector = memo(ModelSelectorInner);
