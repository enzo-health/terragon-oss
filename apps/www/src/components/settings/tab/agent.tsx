"use client";

import { useAtomValue } from "jotai";
import {
  userAtom,
  allAgentsAtom,
  userSettingsAtom,
  useUpdateUserSettingsMutation,
} from "@/atoms/user";
import { CredentialsList } from "@/components/credentials/credentials-list";
import {
  AddClaudeCredentialDialog,
  AddCodexCredentialDialog,
  AddAmpCredentialDialog,
  AddGeminiCredentialDialog,
} from "@/components/credentials/add-credential-dialog";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { SettingsSection, SettingsWithCTA } from "../settings-row";
import { AIAgent, AIModel } from "@terragon/agent/types";
import { Plus } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  getModelInfo,
  getAgentInfo,
  getAgentDisplayName,
  isAgentEnabledByDefault,
  agentToModels,
  getModelDisplayName,
  isModelEnabledByDefault,
  isConnectedCredentialsSupported,
} from "@terragon/agent/utils";
import { Switch } from "@/components/ui/switch";
import { Checkbox } from "@/components/ui/checkbox";
import { AgentIcon } from "@/components/chat/agent-icon";
import { cn } from "@/lib/utils";
import { useFeatureFlag } from "@/hooks/use-feature-flag";

export function AgentSettings() {
  const user = useAtomValue(userAtom);
  const userSettings = useAtomValue(userSettingsAtom);
  if (!user || !userSettings) {
    return null;
  }
  return (
    <div className="flex flex-col gap-8">
      <SettingsSection
        label="Agent configuration"
        description="Customize how the coding agent behaves across all your tasks"
      >
        <CustomSystemPromptSetting />
      </SettingsSection>
      <AgentAndModelsEnabledSection />
      <AgentProvidersSection />
    </div>
  );
}

function AgentProvidersSection() {
  const allAgents = useAtomValue(allAgentsAtom);
  const agents = allAgents.filter((agent) => {
    return isConnectedCredentialsSupported(agent);
  });
  const [selectProviderOpen, setSelectProviderOpen] = useState(false);
  const [selectedAgent, setSelectedAgent] = useState<AIAgent | null>(null);
  const [credentialDialogOpen, setCredentialDialogOpen] = useState(false);

  const handleAgentSelect = (agent: AIAgent) => {
    setSelectedAgent(agent);
    setSelectProviderOpen(false);
    setCredentialDialogOpen(true);
  };

  const addCredentialCTA = (
    <Button
      size="sm"
      variant="outline"
      onClick={() => setSelectProviderOpen(true)}
    >
      <Plus className="h-4 w-4" />
      Add credential
    </Button>
  );

  return (
    <div id="agent-providers">
      <SettingsSection
        label="Agent providers"
        description="Connect provider accounts to power your coding agents"
        cta={addCredentialCTA}
      >
        <CredentialsList />
      </SettingsSection>
      <SelectProviderDialog
        open={selectProviderOpen}
        onOpenChange={setSelectProviderOpen}
        agents={agents}
        onSelect={handleAgentSelect}
      />
      {selectedAgent === "claudeCode" && (
        <AddClaudeCredentialDialog
          open={credentialDialogOpen}
          onOpenChange={(open) => {
            setCredentialDialogOpen(open);
            if (!open) {
              setSelectedAgent(null);
            }
          }}
        />
      )}
      {selectedAgent === "codex" && (
        <AddCodexCredentialDialog
          open={credentialDialogOpen}
          onOpenChange={(open) => {
            setCredentialDialogOpen(open);
            if (!open) {
              setSelectedAgent(null);
            }
          }}
        />
      )}
      {selectedAgent === "amp" && (
        <AddAmpCredentialDialog
          open={credentialDialogOpen}
          onOpenChange={(open) => {
            setCredentialDialogOpen(open);
            if (!open) {
              setSelectedAgent(null);
            }
          }}
        />
      )}
      {selectedAgent === "gemini" && (
        <AddGeminiCredentialDialog
          open={credentialDialogOpen}
          onOpenChange={(open) => {
            setCredentialDialogOpen(open);
            if (!open) {
              setSelectedAgent(null);
            }
          }}
        />
      )}
    </div>
  );
}

function SelectProviderDialog({
  open,
  onOpenChange,
  agents,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agents: AIAgent[];
  onSelect: (agent: AIAgent) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add credential</DialogTitle>
          <DialogDescription>
            Choose which agent provider you’d like to add credentials for.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 py-4">
          {agents.map((agent) => (
            <Button
              key={agent}
              variant="outline"
              className="w-full flex items-center h-11 justify-start gap-2 py-2 pl-3 pr-4"
              onClick={() => onSelect(agent)}
            >
              <AgentIcon agent={agent} sessionId={null} />
              <span>{getAgentDisplayName(agent)}</span>
            </Button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function CustomSystemPromptSetting() {
  const [isSaving, setIsSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const userSettings = useAtomValue(userSettingsAtom);
  const userSettingsMutation = useUpdateUserSettingsMutation();
  const [customSystemPrompt, setCustomSystemPrompt] = useState(
    userSettings?.customSystemPrompt || "",
  );
  const handleChange = (newValue: string) => {
    setCustomSystemPrompt(newValue);
    setHasChanges(true);
  };
  const handleSave = async () => {
    try {
      setIsSaving(true);
      setHasChanges(false);
      await userSettingsMutation.mutateAsync({ customSystemPrompt });
    } finally {
      setIsSaving(false);
    }
  };
  return (
    <SettingsWithCTA label="Custom system prompt" direction="col">
      <div className="flex flex-col gap-3 w-full">
        <Textarea
          value={customSystemPrompt}
          onChange={(e) => handleChange(e.target.value)}
          placeholder="e.g. Always use descriptive variable names…"
          className="min-h-48 rounded-xl"
        />
        <Button
          disabled={!hasChanges || isSaving}
          onClick={handleSave}
          size="sm"
          className="self-start transition-[transform,opacity,background-color] duration-[var(--duration-quick)] ease-[var(--ease-emphasis)] active:scale-[0.96]"
        >
          {isSaving ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </SettingsWithCTA>
  );
}

function useAgentAndModelsEnabledSection() {
  const userSettings = useAtomValue(userSettingsAtom);
  const userSettingsMutation = useUpdateUserSettingsMutation();
  const agentPreferences = userSettings?.agentModelPreferences?.agents || {};
  const modelPreferences = userSettings?.agentModelPreferences?.models || {};
  const updateAgentPreference = async (agent: AIAgent, enabled: boolean) => {
    await userSettingsMutation.mutateAsync({
      agentModelPreferences: {
        ...userSettings?.agentModelPreferences,
        agents: {
          ...userSettings?.agentModelPreferences?.agents,
          [agent]: enabled,
        },
      },
    });
  };
  const updateModelPreference = async (model: AIModel, enabled: boolean) => {
    await userSettingsMutation.mutateAsync({
      agentModelPreferences: {
        ...userSettings?.agentModelPreferences,
        models: {
          ...userSettings?.agentModelPreferences?.models,
          [model]: enabled,
        },
      },
    });
  };

  return {
    agentPreferences,
    modelPreferences,
    updateAgentPreference,
    updateModelPreference,
  };
}

function AgentAndModelsEnabledSection() {
  const allAgents = useAtomValue(allAgentsAtom);
  const { agentPreferences, updateAgentPreference } =
    useAgentAndModelsEnabledSection();
  return (
    <div id="available-agents-and-models">
      <SettingsSection
        label="Available agents and models"
        description="Choose which agents and models are available when you create a new task"
      >
        <div className="space-y-4">
          {allAgents.map((agent) => {
            const isEnabled =
              agentPreferences[agent] ?? isAgentEnabledByDefault(agent);
            return (
              <AgentModelItem
                key={agent}
                agent={agent}
                isEnabled={isEnabled}
                onToggle={(enabled) => updateAgentPreference(agent, enabled)}
              />
            );
          })}
        </div>
      </SettingsSection>
    </div>
  );
}

function AgentModelItem({
  agent,
  isEnabled,
  onToggle,
}: {
  agent: AIAgent;
  isEnabled: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const openCodeOpenAIAnthropicModel = useFeatureFlag(
    "opencodeOpenAIAnthropicModelOption",
  );
  const openCodeGemini3ProModel = useFeatureFlag(
    "opencodeGemini3ProModelOption",
  );
  const models = agentToModels(agent, {
    agentVersion: "latest",
    enableOpenRouterOpenAIAnthropicModel: openCodeOpenAIAnthropicModel,
    enableOpencodeGemini3ProModelOption: openCodeGemini3ProModel,
  });
  const agentLabel = getAgentDisplayName(agent);
  const agentInfo = getAgentInfo(agent);

  return (
    <div
      className={cn(
        "grid grid-cols-[auto_1fr_auto] gap-3 rounded-xl border border-hairline-soft bg-canvas/40 p-4 transition-[opacity,background-color] duration-[var(--duration-quick)] ease-[var(--ease-emphasis)]",
        isEnabled ? "opacity-100" : "opacity-60",
      )}
    >
      <div className="mt-0.5">
        <AgentIcon agent={agent} sessionId={null} />
      </div>
      <div className="min-w-0">
        <p className="text-sm font-medium text-strong text-balance">
          {agentLabel}
        </p>
        {agentInfo && (
          <p className="text-xs text-mid mt-1 text-pretty leading-relaxed">
            {agentInfo}
          </p>
        )}
        {models.length > 1 && (
          <div className="mt-3 flex flex-col">
            {models.map((model) => (
              <ModelItem key={model} model={model} agentEnabled={isEnabled} />
            ))}
          </div>
        )}
      </div>
      <Switch
        checked={isEnabled}
        onCheckedChange={onToggle}
        className="mt-0.5"
        aria-label={`Enable ${agentLabel}`}
      />
    </div>
  );
}

function ModelItem({
  model,
  agentEnabled,
}: {
  model: AIModel;
  agentEnabled: boolean;
}) {
  const displayName = getModelDisplayName(model);
  const modelInfo = getModelInfo(model);
  const { modelPreferences, updateModelPreference } =
    useAgentAndModelsEnabledSection();
  const isEnabled =
    modelPreferences[model] ??
    isModelEnabledByDefault({ model, agentVersion: "latest" });
  return (
    <label
      htmlFor={`model-${model}`}
      className={cn(
        "flex min-h-10 cursor-pointer items-start gap-3 rounded-lg px-2 py-1.5 -mx-2 transition-colors duration-[var(--duration-quick)] ease-[var(--ease-emphasis)]",
        agentEnabled ? "hover:bg-canvas/70" : "cursor-not-allowed opacity-60",
        !isEnabled && agentEnabled && "opacity-70",
      )}
    >
      <Checkbox
        id={`model-${model}`}
        checked={isEnabled}
        onCheckedChange={(checked) => updateModelPreference(model, !!checked)}
        disabled={!agentEnabled}
        className="mt-0.5 shrink-0"
      />
      <span className="flex flex-col gap-0.5 min-w-0">
        <span className="text-sm font-medium text-strong text-balance">
          {displayName.fullName}
        </span>
        {modelInfo && (
          <span className="text-xs text-mid text-pretty leading-relaxed">
            {modelInfo}
          </span>
        )}
      </span>
    </label>
  );
}
