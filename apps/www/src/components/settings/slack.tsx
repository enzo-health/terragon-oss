"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slack } from "lucide-react";
import { useUpdateSlackSettings } from "@/queries/slack-mutations";
import { ConnectionStatusPill } from "../credentials/connection-status-pill";
import { toast } from "sonner";
import {
  getSlackAppInstallUrl,
  getSlackOAuthUrl,
  disconnectSlackAccount,
} from "@/server-actions/slack";
import { useRouter } from "next/navigation";
import { ModelSelector } from "../model-selector";
import { RepoSelector } from "../repo-branch-selector";
import { useRealtimeUser } from "@/hooks/useRealtime";
import { SlackAccountWithMetadata } from "@terragon/shared/db/types";
import { AIModel } from "@terragon/agent/types";
import { useServerActionMutation } from "@/queries/server-action-helpers";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";

function SlackAccountItem({ account }: { account: SlackAccountWithMetadata }) {
  const router = useRouter();
  const updateMutation = useUpdateSlackSettings();
  const [showDisconnectConfirm, setShowDisconnectConfirm] = useState(false);
  const [isInstallRedirecting, setIsInstallRedirecting] = useState(false);
  const [defaultRepo, setDefaultRepo] = useState(
    account.settings?.defaultRepoFullName || "",
  );
  const [defaultModel, setDefaultModel] = useState<AIModel | null>(
    account.settings?.defaultModel || null,
  );
  const getSlackAppInstallUrlMutation = useServerActionMutation({
    mutationFn: getSlackAppInstallUrl,
  });
  const disconnectSlackAccountMutation = useServerActionMutation({
    mutationFn: disconnectSlackAccount,
    onSuccess: () => {
      toast.success("Slack account disconnected");
      setShowDisconnectConfirm(false);
      router.refresh();
    },
  });

  useEffect(() => {
    setDefaultRepo(account.settings?.defaultRepoFullName || "");
    setDefaultModel(account.settings?.defaultModel || null);
  }, [
    account.id,
    account.settings?.defaultModel,
    account.settings?.defaultRepoFullName,
  ]);

  const handleInstallApp = async () => {
    setIsInstallRedirecting(true);
    try {
      const appInstallUrl = await getSlackAppInstallUrlMutation.mutateAsync();
      window.location.href = appInstallUrl;
    } catch {
      setIsInstallRedirecting(false);
    }
  };

  const isConnected = !!account.installation;

  return (
    <div className="space-y-4 rounded-xl border border-hairline-soft bg-canvas/40 p-4">
      <div className="flex items-start justify-between">
        <div className="flex flex-col gap-2 flex-1">
          <div className="flex items-center gap-2">
            <Slack className="h-5 w-5" />
            <span className="font-semibold">{account.slackTeamName}</span>
            <ConnectionStatusPill connected={isConnected} />
          </div>
          <p className="text-xs text-mid">
            Workspace ID: <span className="font-mono">{account.teamId}</span>
          </p>
        </div>
      </div>

      {!isConnected ? (
        <div className="space-y-2">
          <p className="text-sm text-mid">
            The Slack app needs to be installed in your workspace to complete
            the setup.
          </p>
          <Button
            size="sm"
            onClick={handleInstallApp}
            disabled={
              isInstallRedirecting || getSlackAppInstallUrlMutation.isPending
            }
          >
            <Slack className="h-4 w-4" />
            {isInstallRedirecting || getSlackAppInstallUrlMutation.isPending
              ? "Redirecting…"
              : "Install Slack app"}
          </Button>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-4 sm:flex-row">
            <div className="space-y-1">
              <Label className="text-sm">Default repository</Label>
              <RepoSelector
                selectedRepoFullName={defaultRepo}
                onChange={(repoFullName) => {
                  if (repoFullName) {
                    setDefaultRepo(repoFullName);
                    updateMutation.mutate({
                      teamId: account.teamId,
                      settings: {
                        defaultRepoFullName: repoFullName,
                        ...(defaultModel ? { defaultModel } : {}),
                      },
                    });
                  }
                }}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-sm">Default model</Label>
              <ModelSelector
                className="border-solid p-2 text-foreground bg-raised"
                forcedAgent={null}
                forcedAgentVersion={null}
                isMultiAgentMode={false}
                supportsMultiAgentPromptSubmission={false}
                setIsMultiAgentMode={() => {}}
                selectedModels={{}}
                selectedModel={defaultModel ?? undefined}
                setSelectedModel={({ model }: { model: AIModel }) => {
                  setDefaultModel(model);
                  updateMutation.mutate({
                    teamId: account.teamId,
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
              onClick={() => setShowDisconnectConfirm(true)}
              disabled={disconnectSlackAccountMutation.isPending}
              size="sm"
              variant="link"
              className="text-mid font-normal underline px-0 hover:text-strong"
            >
              {disconnectSlackAccountMutation.isPending
                ? "Disconnecting…"
                : "Disconnect my Slack account"}
            </Button>
            <DeleteConfirmationDialog
              open={showDisconnectConfirm}
              onOpenChange={setShowDisconnectConfirm}
              onConfirm={() =>
                disconnectSlackAccountMutation.mutate({
                  teamId: account.teamId,
                })
              }
              title="Disconnect Slack account"
              description="This disconnects your Slack account from Terragon. The workspace app installation and other users are unaffected."
              confirmText="Disconnect"
              isLoading={disconnectSlackAccountMutation.isPending}
            />
          </div>
        </>
      )}
    </div>
  );
}

export function SlackAccountSettings({
  accounts,
}: {
  accounts: SlackAccountWithMetadata[];
}) {
  const router = useRouter();
  useRealtimeUser({
    matches: (message) => !!message.data.slack,
    onMessage: () => router.refresh(),
  });
  const getSlackOAuthUrlMutation = useServerActionMutation({
    mutationFn: getSlackOAuthUrl,
  });
  const [isConnectRedirecting, setIsConnectRedirecting] = useState(false);
  const handleConnect = async () => {
    setIsConnectRedirecting(true);
    try {
      const authUrl = await getSlackOAuthUrlMutation.mutateAsync();
      window.location.href = authUrl;
    } catch {
      setIsConnectRedirecting(false);
    }
  };

  // No connections - show connect prompt
  if (accounts.length === 0) {
    return (
      <div className="flex flex-col gap-2 rounded-lg w-full">
        <p className="text-sm">
          Connect your Slack workspace to interact with Terragon through Slack
        </p>
        <div className="flex">
          <Button
            size="sm"
            onClick={handleConnect}
            disabled={
              isConnectRedirecting || getSlackOAuthUrlMutation.isPending
            }
          >
            <Slack className="h-4 w-4" />
            {isConnectRedirecting || getSlackOAuthUrlMutation.isPending
              ? "Redirecting…"
              : "Connect Slack workspace"}
          </Button>
        </div>
      </div>
    );
  }
  // Has connections - show workspaces and settings
  return (
    <div className="flex flex-col w-full gap-2">
      {accounts.map((account) => {
        return <SlackAccountItem key={account.id} account={account} />;
      })}
      <div className="flex">
        <Button
          variant="link"
          size="sm"
          onClick={handleConnect}
          disabled={isConnectRedirecting || getSlackOAuthUrlMutation.isPending}
          className="text-mid font-normal underline px-0 hover:text-strong"
        >
          {isConnectRedirecting || getSlackOAuthUrlMutation.isPending
            ? "Redirecting…"
            : "Connect another workspace"}
        </Button>
      </div>
    </div>
  );
}
