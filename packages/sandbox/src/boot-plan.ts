import type { CreateSandboxOptions } from "./types";

type BootPlanAgent = NonNullable<CreateSandboxOptions["agent"]>;

export type BootPlanBranchAction =
  | { type: "create" }
  | { type: "checkout"; branchName: string }
  | { type: "none" };

export type BootPlanSetupScriptMode = "skip" | "background" | "foreground";

export type BootPlan = {
  shouldCloneRepo: boolean;
  shouldRefreshSnapshotRepo: boolean;
  branchAction: BootPlanBranchAction;
  setupScriptMode: BootPlanSetupScriptMode;
  shouldProbeSandboxAgent: boolean;
  shouldUpdateAgentFiles: boolean;
  agentToUpdate: BootPlanAgent | null;
  shouldRestartDaemon: boolean;
  shouldUpdateDaemonBeforeRestart: boolean;
};

export type SandboxBootStep =
  | { type: "profile" }
  | { type: "daytona-volume-paths" }
  | { type: "clone-repo" }
  | { type: "refresh-snapshot-repo" }
  | { type: "git-identity" }
  | { type: "branch"; action: BootPlanBranchAction }
  | { type: "git-clean" }
  | { type: "install-daemon-and-probe" }
  | { type: "setup-script"; mode: BootPlanSetupScriptMode }
  | { type: "git-credentials" }
  | { type: "probe-sandbox-agent" }
  | { type: "update-agent-files"; agent: BootPlanAgent }
  | { type: "restart-daemon"; updateBeforeRestart: boolean };

export type SandboxBootRecipe = {
  provider: CreateSandboxOptions["sandboxProvider"];
  mode: "create" | "resume";
  steps: SandboxBootStep[];
};

export function buildBootPlan({
  options,
  isCreatingSandbox,
}: {
  options: CreateSandboxOptions;
  isCreatingSandbox: boolean;
}): BootPlan {
  const hasSnapshot = Boolean(options.snapshotTemplateId);
  const agentToUpdate =
    options.agent && (!options.fastResume || options.agent === "codex")
      ? options.agent
      : null;

  return {
    shouldCloneRepo: !hasSnapshot,
    shouldRefreshSnapshotRepo: hasSnapshot,
    branchAction: buildBranchAction(options),
    setupScriptMode: buildSetupScriptMode(options),
    shouldProbeSandboxAgent: !options.fastResume || isCreatingSandbox,
    shouldUpdateAgentFiles: agentToUpdate !== null,
    agentToUpdate,
    shouldRestartDaemon: !isCreatingSandbox,
    shouldUpdateDaemonBeforeRestart:
      !isCreatingSandbox && options.autoUpdateDaemon && !options.fastResume,
  };
}

export function buildSandboxBootRecipe({
  options,
  isCreatingSandbox,
}: {
  options: CreateSandboxOptions;
  isCreatingSandbox: boolean;
}): SandboxBootRecipe {
  const plan = buildBootPlan({ options, isCreatingSandbox });
  const steps: SandboxBootStep[] = [];

  if (isCreatingSandbox) {
    steps.push({ type: "profile" });
    if (options.daytonaVolume) {
      steps.push({ type: "daytona-volume-paths" });
    }
    steps.push({ type: "git-credentials" });
    steps.push(
      plan.shouldCloneRepo
        ? { type: "clone-repo" }
        : { type: "refresh-snapshot-repo" },
    );
    steps.push(
      { type: "git-identity" },
      { type: "branch", action: plan.branchAction },
      { type: "git-clean" },
      { type: "install-daemon-and-probe" },
      { type: "setup-script", mode: plan.setupScriptMode },
    );
  }

  if (!isCreatingSandbox) {
    steps.push({ type: "git-credentials" });
  }
  if (plan.shouldProbeSandboxAgent) {
    steps.push({ type: "probe-sandbox-agent" });
  }
  if (plan.shouldUpdateAgentFiles && plan.agentToUpdate !== null) {
    steps.push({ type: "update-agent-files", agent: plan.agentToUpdate });
  }
  if (plan.shouldRestartDaemon) {
    steps.push({
      type: "restart-daemon",
      updateBeforeRestart: plan.shouldUpdateDaemonBeforeRestart,
    });
  }

  return {
    provider: options.sandboxProvider,
    mode: isCreatingSandbox ? "create" : "resume",
    steps,
  };
}

function buildBranchAction(
  options: CreateSandboxOptions,
): BootPlanBranchAction {
  if (options.createNewBranch) {
    return { type: "create" };
  }

  if (options.branchName) {
    return { type: "checkout", branchName: options.branchName };
  }

  return { type: "none" };
}

function buildSetupScriptMode(
  options: CreateSandboxOptions,
): BootPlanSetupScriptMode {
  if (options.skipSetupScript || options.snapshotTemplateId) {
    return "skip";
  }

  if (options.backgroundSetupScript) {
    return "background";
  }

  return "foreground";
}
