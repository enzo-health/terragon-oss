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
  getLinearAgentInstallUrl,
  uninstallLinearWorkspace,
} from "@/server-actions/linear";
import { useRouter } from "next/navigation";
import { ModelSelector } from "../../model-selector";
import { RepoSelector } from "../../repo-branch-selector";
import { useRealtimeUser } from "@/hooks/useRealtime";
import {
  LinearAccountWithSettingsAndInstallation,
  LinearInstallationPublic,
} from "@terragon/shared/db/types";
import { AIModel } from "@terragon/agent/types";
import { useServerActionMutation } from "@/queries/server-action-helpers";
import { DeleteConfirmationDialog } from "@/components/delete-confirmation-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

// ── Workspace Install Panel ──────────────────────────────────────────────────

function LinearWorkspacePanel({
  installation,
}: {
  installation: LinearInstallationPublic | null;
}) {
  const router = useRouter();
  const [showUninstallDialog, setShowUninstallDialog] = useState(false);

  const installUrlMutation = useServerActionMutation({
    mutationFn: getLinearAgentInstallUrl,
  });

  const uninstallMutation = useServerActionMutation({
    mutationFn: uninstallLinearWorkspace,
    onSuccess: () => {
      toast.success("Linear agent uninstalled from workspace");
      setShowUninstallDialog(false);
      router.refresh();
    },
  });

  const handleInstall = async () => {
    const url = await installUrlMutation.mutateAsync();
    window.location.href = url;
  };

  const handleUninstallConfirm = () => {
    if (!installation) return;
    uninstallMutation.mutate({ organizationId: installation.organizationId });
  };

  if (!installation) {
    return (
      <div className="flex flex-col gap-2 rounded-lg border p-4">
        <div className="flex items-center gap-2">
          <SquareKanban className="h-5 w-5" />
          <span className="font-semibold">Workspace Agent</span>
          <ConnectionStatusPill connected={false} />
        </div>
        <p className="text-sm text-muted-foreground">
          Install the Linear Agent in your workspace to allow Terragon to
          respond to mentions and create tasks automatically.
        </p>
        <div className="flex">
          <Button
            size="sm"
            onClick={handleInstall}
            disabled={installUrlMutation.isPending}
          >
            <SquareKanban className="h-4 w-4" />
            {installUrlMutation.isPending
              ? "Redirecting..."
              : "Install Linear Agent"}
          </Button>
        </div>
      </div>
    );
  }

  const isActive = installation.isActive;

  return (
    <>
      <div className="flex flex-col gap-3 rounded-lg border p-4">
        <div className="flex items-start justify-between">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <SquareKanban className="h-5 w-5" />
              <span className="font-semibold">
                {installation.organizationName}
              </span>
              <ConnectionStatusPill connected={isActive} />
              {!isActive && (
                <span className="text-xs text-destructive font-medium">
                  Reinstall required
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              Organization ID: {installation.organizationId}
            </p>
            {installation.createdAt && (
              <p className="text-xs text-muted-foreground">
                Installed:{" "}
                {new Date(installation.createdAt).toLocaleDateString()}
              </p>
            )}
          </div>
        </div>

        {!isActive && (
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">
              The agent token has expired or been revoked. Reinstall to restore
              functionality.
            </p>
            <Button
              size="sm"
              onClick={handleInstall}
              disabled={installUrlMutation.isPending}
            >
              <SquareKanban className="h-4 w-4" />
              {installUrlMutation.isPending
                ? "Redirecting..."
                : "Reinstall Agent"}
            </Button>
          </div>
        )}

        <div className="border-t pt-3">
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  onClick={() => setShowUninstallDialog(true)}
                  disabled={uninstallMutation.isPending}
                  size="sm"
                  variant="link"
                  className="text-muted-foreground font-normal underline px-0 opacity-50 hover:opacity-100"
                >
                  Uninstall workspace
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                <p>
                  Disables the Linear agent for all users in this workspace.
                  Individual account links remain intact.
                </p>
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>

      <DeleteConfirmationDialog
        open={showUninstallDialog}
        onOpenChange={setShowUninstallDialog}
        onConfirm={handleUninstallConfirm}
        title="Uninstall Linear Agent"
        description="This will disable the Linear agent for all users in this workspace. Individual account links remain intact. Are you sure?"
        confirmText="Uninstall"
        isLoading={uninstallMutation.isPending}
      />
    </>
  );
}

// ── Per-user Account Item ─────────────────────────────────────────────────────

function LinearAccountItem({
  account,
}: {
  account: LinearAccountWithSettingsAndInstallation;
}) {
  const router = useRouter();
  const updateMutation = useUpdateLinearSettings();
  const [defaultRepo, setDefaultRepo] = useState(
    account.settings?.defaultRepoFullName || "",
  );
  const [defaultModel, setDefaultModel] = useState<AIModel | null>(
    account.settings?.defaultModel || null,
  );

  const disconnectMutation = useServerActionMutation({
    mutationFn: disconnectLinearAccount,
    onSuccess: () => {
      toast.success("Linear account disconnected");
      router.refresh();
    },
  });

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
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                onClick={() =>
                  disconnectMutation.mutate({
                    organizationId: account.organizationId,
                  })
                }
                disabled={disconnectMutation.isPending}
                size="sm"
                variant="link"
                className="text-muted-foreground font-normal underline px-0 opacity-50 hover:opacity-100"
              >
                {disconnectMutation.isPending
                  ? "Disconnecting..."
                  : "Disconnect my account"}
              </Button>
            </TooltipTrigger>
            <TooltipContent>
              <p>
                Removes your personal Linear account link. Other users are
                unaffected.
              </p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </div>
  );
}

// ── Manual Connect Form ───────────────────────────────────────────────────────

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
        Link your Linear account to identify you when the agent receives
        mentions in your workspace.
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
          {connectMutation.isPending ? "Connecting..." : "Link Linear Account"}
        </Button>
      </div>
    </form>
  );
}

// ── Main Export ───────────────────────────────────────────────────────────────

export function LinearAccountSettings({
  accounts,
  installation,
}: {
  accounts: LinearAccountWithSettingsAndInstallation[];
  installation: LinearInstallationPublic | null;
}) {
  const router = useRouter();
  useRealtimeUser({
    matches: (message) => !!message.data.linear,
    onMessage: () => router.refresh(),
  });

  return (
    <div className="flex flex-col w-full gap-4">
      {/* Workspace-level installation panel (shown once) */}
      <LinearWorkspacePanel installation={installation} />

      {/* Per-user account links */}
      {accounts.length > 0 ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium text-muted-foreground">
            Your account link
          </p>
          {accounts.map((account) => (
            <LinearAccountItem key={account.id} account={account} />
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium text-muted-foreground">
            Your account link
          </p>
          <LinearConnectForm />
        </div>
      )}
    </div>
  );
}
