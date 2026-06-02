import type { SandboxProvider } from "@terragon/types/sandbox";
import type { CreateSandboxOptions } from "./types";
import { getSandboxProvider } from "./provider";
import { setupSandboxEveryTime, setupSandboxOneTime } from "./setup";
import { normalizeCreateSandboxOptions } from "./create-sandbox-options";

export async function getOrCreateSandbox(
  sandboxId: string | null,
  options: CreateSandboxOptions,
) {
  const sandboxOptions = normalizeCreateSandboxOptions(options);
  const provider = getSandboxProvider(sandboxOptions.sandboxProvider);
  const log = (msg: string) => {
    console.log(`[${sandboxOptions.sandboxProvider}] ${msg}`);
  };
  const startTime = Date.now();
  if (sandboxId) {
    log(`Resuming sandbox ${sandboxId}...`);
    await sandboxOptions.onStatusUpdate({
      sandboxId,
      sandboxStatus: "booting",
      bootingStatus: "provisioning",
    });
  } else {
    log(`Creating new sandbox for ${sandboxOptions.githubRepoFullName}...`);
    await sandboxOptions.onStatusUpdate({
      sandboxId: null,
      sandboxStatus: "provisioning",
      bootingStatus: "provisioning",
    });
  }
  const sandbox = await provider.getOrCreateSandbox(sandboxId, sandboxOptions);
  if (sandboxOptions.onSandboxAllocated) {
    try {
      await sandboxOptions.onSandboxAllocated({
        sandboxId: sandbox.sandboxId,
        isCreatingSandbox: !sandboxId,
      });
    } catch (error) {
      if (!sandboxId) {
        try {
          await sandbox.shutdown();
        } catch (shutdownError) {
          console.warn(
            `[${sandboxOptions.sandboxProvider}] failed to clean up sandbox ${sandbox.sandboxId} after allocation persistence failed`,
            shutdownError,
          );
        }
      }
      console.error(
        `[${sandboxOptions.sandboxProvider}] failed to persist allocated sandbox id ${sandbox.sandboxId}`,
        error,
      );
      throw error;
    }
  }
  await sandboxOptions.onStatusUpdate({
    sandboxId: sandbox.sandboxId,
    sandboxStatus: "booting",
    bootingStatus: "provisioning-done",
  });
  log(`setupSandboxEveryTime ${sandbox.sandboxId}...`);
  await setupSandboxEveryTime({
    session: sandbox,
    options: sandboxOptions,
    isCreatingSandbox: !sandboxId,
  });
  if (!sandboxId) {
    log(`setupSandboxOneTime ${sandbox.sandboxId}...`);
    await setupSandboxOneTime(sandbox, sandboxOptions);
  }
  const duration = Date.now() - startTime;
  if (sandboxId) {
    log(`Resumed sandbox ${sandbox.sandboxId} in ${duration}ms`);
  } else {
    log(`Created sandbox ${sandbox.sandboxId} in ${duration}ms`);
  }
  await sandboxOptions.onStatusUpdate({
    sandboxId: sandbox.sandboxId,
    sandboxStatus: "running",
    bootingStatus: null,
  });
  return sandbox;
}

export async function hibernateSandbox({
  sandboxProvider,
  sandboxId,
}: {
  sandboxProvider: SandboxProvider;
  sandboxId: string;
}) {
  const provider = getSandboxProvider(sandboxProvider);
  await provider.hibernateById(sandboxId);
}

export async function extendSandboxLife({
  sandboxProvider,
  sandboxId,
}: {
  sandboxProvider: SandboxProvider;
  sandboxId: string;
}) {
  const provider = getSandboxProvider(sandboxProvider);
  await provider.extendLife(sandboxId);
}

export async function getSandboxOrNull({
  sandboxProvider,
  sandboxId,
}: {
  sandboxProvider: SandboxProvider;
  sandboxId: string;
}) {
  const provider = getSandboxProvider(sandboxProvider);
  return await provider.getSandboxOrNull(sandboxId);
}
