"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SquareKanban } from "lucide-react";
import { useUpdateLinearSettings } from "@/queries/linear-mutations";
import { ConnectionStatusPill } from "../../credentials/connection-status-pill";
import { toast } from "sonner";
import {
  connectLinearAccount,
  disconnectLinearAccount,
} from "@/server-actions/linear";
import { useRouter } from "next/navigation";
import { ModelSelector } from "../../model-selector";
import { RepoSelector } from "../../repo-branch-selector";
import { useRealtimeUser } from "@/hooks/useRealtime";
import { LinearAccountWithSettings } from "@terragon/shared/db/types";
import { AIModel } from "@terragon/agent/types";
import { useServerActionMutation } from "@/queries/server-action-helpers";

function LinearAccountItem({
  account,
}: {
  account: LinearAccountWithSettings;
}) {
  const router = useRouter();
  const updateMutation = useUpdateLinearSettings();
  const [isDisconnecting, setIsDisconnecting] = useState(false);
  const [defaultRepo, setDefaultRepo] = useState(
    account.settings?.defaultRepoFullName || "",
  );
  const [defaultModel, setDefaultModel] = useState<AIModel | null>(
    account.settings?.defaultModel || null,
  );

  const handleDisconnect = async () => {
    try {
      setIsDisconnecting(true);
      await disconnectLinearAccount({
        organizationId: account.organizationId,
      });
      toast.success("Linear account disconnected");
      router.refresh();
    } catch (error) {
      console.error("Failed to disconnect Linear:", error);
      toast.error("Failed to disconnect Linear account");
    } finally {
      setIsDisconnecting(false);
    }
  };

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div className="flex items-start justify-between">
        <div className="flex flex-col gap-2 flex-1">
          <div className="flex items-center gap-2">
            <SquareKanban className="h-5 w-5" />
            <span className="font-semibold">{account.linearUserName}</span>
            <ConnectionStatusPill connected={true} />
          </div>
          <p className="text-xs text-muted-foreground">
            Organization ID: {account.organizationId}
          </p>
          <p className="text-xs text-muted-foreground">
            {account.linearUserEmail}
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-4 sm:flex-row">
        <div className="space-y-1">
          <Label className="text-sm">Default Repository</Label>
          <RepoSelector
            selectedRepoFullName={defaultRepo}
            onChange={(repoFullName) => {
              if (repoFullName) {
                setDefaultRepo(repoFullName);
                updateMutation.mutate({
                  organizationId: account.organizationId,
                  settings: {
                    defaultRepoFullName: repoFullName,
                    defaultModel: defaultModel!,
                  },
                });
              }
            }}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-sm">Default Model</Label>
          <ModelSelector
            className="border-solid p-2 text-foreground bg-transparent dark:!bg-muted"
            forcedAgent={null}
            forcedAgentVersion={null}
            isMultiAgentMode={false}
            supportsMultiAgentPromptSubmission={false}
            setIsMultiAgentMode={() => {}}
            selectedModels={{}}
            selectedModel={defaultModel as any}
            setSelectedModel={({ model }: { model: AIModel }) => {
              setDefaultModel(model);
              updateMutation.mutate({
                organizationId: account.organizationId,
                settings: {
                  defaultModel: model,
                },
              });
            }}
          />
        </div>
      </div>
      <div className="space-x-2">
        <Button
          onClick={handleDisconnect}
          disabled={isDisconnecting}
          size="sm"
          variant="link"
          className="text-muted-foreground font-normal underline px-0 opacity-50 hover:opacity-100"
        >
          {isDisconnecting ? "Disconnecting..." : "Disconnect"}
        </Button>
      </div>
    </div>
  );
}

function LinearConnectForm() {
  const router = useRouter();
  const [organizationId, setOrganizationId] = useState("");
  const [linearUserId, setLinearUserId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");

  const connectMutation = useServerActionMutation({
    mutationFn: connectLinearAccount,
    onSuccess: () => {
      toast.success("Linear account connected");
      setOrganizationId("");
      setLinearUserId("");
      setDisplayName("");
      setEmail("");
      router.refresh();
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!organizationId || !linearUserId || !displayName || !email) {
      toast.error("All fields are required");
      return;
    }
    connectMutation.mutate({
      organizationId,
      linearUserId,
      linearUserName: displayName,
      linearUserEmail: email,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <p className="text-sm">
        Link your Linear account to interact with Terragon through Linear issue
        comments.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="space-y-1">
          <Label className="text-sm">Organization ID</Label>
          <Input
            placeholder="e.g. abc123-def456"
            value={organizationId}
            onChange={(e) => setOrganizationId(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-sm">User ID</Label>
          <Input
            placeholder="Your Linear user ID"
            value={linearUserId}
            onChange={(e) => setLinearUserId(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-sm">Display Name</Label>
          <Input
            placeholder="Your name in Linear"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-sm">Email</Label>
          <Input
            type="email"
            placeholder="Your Linear email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
      </div>
      <div className="flex">
        <Button type="submit" size="sm" disabled={connectMutation.isPending}>
          <SquareKanban className="h-4 w-4" />
          {connectMutation.isPending
            ? "Connecting..."
            : "Connect Linear Account"}
        </Button>
      </div>
    </form>
  );
}

export function LinearAccountSettings({
  accounts,
}: {
  accounts: LinearAccountWithSettings[];
}) {
  const router = useRouter();
  useRealtimeUser({
    matches: (message) => !!message.data.linear,
    onMessage: () => router.refresh(),
  });

  if (accounts.length === 0) {
    return <LinearConnectForm />;
  }

  return (
    <div className="flex flex-col w-full gap-2">
      {accounts.map((account) => (
        <LinearAccountItem key={account.id} account={account} />
      ))}
    </div>
  );
}
