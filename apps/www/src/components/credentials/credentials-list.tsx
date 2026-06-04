"use client";

import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { KeyRound, Trash2 } from "lucide-react";
import { useAtomValue } from "jotai";
import {
  useCredentials,
  useDeleteCredentialsMutation,
  useToggleActiveCredentialMutation,
} from "@/queries/credentials-queries";
import type { AgentProviderCredentialsMap } from "@/server-lib/credentials";
import { AIAgent } from "@terragon/agent/types";
import {
  getAgentDisplayName,
  isConnectedCredentialsSupported,
} from "@terragon/agent/utils";
import { AgentIcon } from "@/components/chat/agent-icon";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import { allAgentsAtom } from "@/atoms/user";

type CredentialData = NonNullable<AgentProviderCredentialsMap[AIAgent]>[number];

function CredentialDeleteButton({
  credential,
  agent,
  onDelete,
  deletePending,
}: {
  credential: CredentialData;
  agent: AIAgent;
  onDelete: () => void;
  deletePending: boolean;
}) {
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const isOAuth = credential.type === "oauth";
  const agentName = getAgentDisplayName(agent);
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        className="size-8 p-0 text-muted-foreground hover:text-strong"
        onClick={() => setShowDeleteDialog(true)}
        disabled={deletePending}
        aria-label={isOAuth ? "Disconnect" : "Delete"}
      >
        <Trash2 className="h-4 w-4" />
      </Button>
      <DeleteConfirmationDialog
        open={showDeleteDialog}
        onOpenChange={setShowDeleteDialog}
        onConfirm={() => {
          onDelete();
          setShowDeleteDialog(false);
        }}
        title={isOAuth ? "Disconnect account" : "Delete credential"}
        description={
          isOAuth
            ? `Disconnect your ${agentName} account? Tasks using it will fall back to another credential.`
            : `Delete this ${agentName} API key? You can add it again later.`
        }
        confirmText={isOAuth ? "Disconnect" : "Delete"}
        isLoading={deletePending}
      />
    </>
  );
}

type CredentialWithAgent = CredentialData & {
  agent: AIAgent;
  agentName: string;
};

function CredentialsListItem({
  credential,
}: {
  credential: CredentialWithAgent;
}) {
  const deleteMutation = useDeleteCredentialsMutation();
  const toggleActiveMutation = useToggleActiveCredentialMutation();
  return (
    <div
      className={cn(
        "rounded-xl border border-hairline-soft bg-canvas/40 p-4 transition-opacity duration-[var(--duration-quick)] ease-[var(--ease-emphasis)]",
        { "opacity-60": !credential.isActive },
      )}
    >
      <div className="grid grid-cols-[auto_1fr_auto_auto] items-start gap-3">
        {/* Icon column */}
        <div className="flex h-5 items-center">
          <AgentIcon agent={credential.agent} sessionId={null} />
        </div>
        {/* Text column */}
        <div className="flex flex-col min-w-0">
          <div className="flex flex-row items-center gap-2">
            <span className="text-sm font-medium truncate">
              {credential.agentName}
            </span>
            <Badge variant="outline">
              {credential.type === "api-key" ? "API Key" : "Account"}
            </Badge>
          </div>
          {credential.type === "oauth" &&
            credential.metadata &&
            typeof credential.metadata === "object" && (
              <div className="flex flex-col gap-0.5 mt-0.5">
                {/* Claude OAuth - accountEmail */}
                {"accountEmail" in credential.metadata &&
                  credential.metadata.accountEmail && (
                    <span className="text-xs text-muted-foreground">
                      {String(credential.metadata.accountEmail)}
                    </span>
                  )}
                {/* Codex OAuth - email */}
                {credential.agent === "codex" &&
                  "email" in credential.metadata &&
                  credential.metadata.email && (
                    <span className="text-xs text-muted-foreground">
                      {String(credential.metadata.email)}
                    </span>
                  )}
              </div>
            )}
        </div>
        {/* Switch column */}
        <div className="flex h-5 items-center">
          <Switch
            checked={credential.isActive}
            onCheckedChange={async (newChecked) => {
              await toggleActiveMutation.mutateAsync({
                credentialId: credential.id,
                isActive: newChecked,
              });
            }}
          />
        </div>
        {/* Trash column */}
        <div className="flex h-5 items-center">
          <CredentialDeleteButton
            credential={credential}
            agent={credential.agent}
            onDelete={() => {
              deleteMutation.mutateAsync({ credentialId: credential.id });
            }}
            deletePending={deleteMutation.isPending}
          />
        </div>
      </div>
    </div>
  );
}

export function CredentialsList() {
  const allAgents = useAtomValue(allAgentsAtom);
  // Filter to only show agents that support credentials
  const agents = allAgents.filter((agent) => {
    return isConnectedCredentialsSupported(agent);
  });
  const { data: agentProviderCredentials } = useCredentials();
  const allCredentials = useMemo(() => {
    return agents.flatMap((agent) => {
      const credentials = agentProviderCredentials?.[agent] || [];
      return credentials.map((credential) => ({
        ...credential,
        agent,
        agentName: getAgentDisplayName(agent),
      }));
    });
  }, [agentProviderCredentials, agents]);

  if (!agentProviderCredentials) {
    return (
      <div className="space-y-2">
        {[0, 1].map((i) => (
          <div
            key={i}
            className="h-[68px] rounded-xl border border-hairline-soft bg-canvas/40 animate-pulse"
          />
        ))}
      </div>
    );
  }
  if (allCredentials.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-hairline-soft p-8 text-center">
        <KeyRound className="size-5 text-muted-foreground" aria-hidden />
        <p className="text-sm font-medium text-strong">No credentials yet</p>
        <p className="text-pretty text-xs text-muted-foreground">
          Use “Add credential” above to connect a provider account or API key.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {allCredentials.map((credential) => (
        <CredentialsListItem key={credential.id} credential={credential} />
      ))}
    </div>
  );
}
