import type { SandboxProvider } from "@leo/types/sandbox";
import type { CreateSandboxOptions } from "./types";
import { getSandboxProvider } from "./provider";
import { setupSandboxEveryTime, setupSandboxOneTime } from "./setup";

export async function getOrCreateSandbox(
  sandboxId: string | null,
  options: CreateSandboxOptions,
) {
  const provider = getSandboxProvider(options.sandboxProvider);
  const log = (msg: string) => {
    console.log(`[${options.sandboxProvider}] ${msg}`);
  };
  const startTime = Date.now();
  if (sandboxId) {
    log(`Resuming sandbox ${sandboxId}...`);
    await options.onStatusUpdate({
      sandboxId,
      sandboxStatus: "booting",
      bootingStatus: "provisioning",
    });
  } else {
    log(`Creating new sandbox for ${options.githubRepoFullName}...`);
    await options.onStatusUpdate({
      sandboxId: null,
      sandboxStatus: "provisioning",
      bootingStatus: "provisioning",
    });
  }
  const sandbox = await provider.getOrCreateSandbox(sandboxId, options);
  if (options.onSandboxAllocated) {
    try {
      await options.onSandboxAllocated({
        sandboxId: sandbox.sandboxId,
        isCreatingSandbox: !sandboxId,
      });
    } catch (error) {
      console.warn(
        `[${options.sandboxProvider}] failed to persist allocated sandbox id ${sandbox.sandboxId}`,
        error,
      );
    }
  }
  await options.onStatusUpdate({
    sandboxId: sandbox.sandboxId,
    sandboxStatus: "booting",
    bootingStatus: "provisioning-done",
  });
  log(`setupSandboxEveryTime ${sandbox.sandboxId}...`);
  await setupSandboxEveryTime({
    session: sandbox,
    options,
    isCreatingSandbox: !sandboxId,
  });
  if (!sandboxId) {
    log(`setupSandboxOneTime ${sandbox.sandboxId}...`);
    await setupSandboxOneTime(sandbox, options);
  }
  const duration = Date.now() - startTime;
  if (sandboxId) {
    log(`Resumed sandbox ${sandbox.sandboxId} in ${duration}ms`);
  } else {
    log(`Created sandbox ${sandbox.sandboxId} in ${duration}ms`);
  }
  await options.onStatusUpdate({
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
