import {
  getDecryptedEnvironmentVariables,
  getOrCreateGlobalEnvironment,
  getEnvironment,
  getDecryptedMcpConfig,
} from "@terragon/shared/model/environments";
import { getUserIdOrNull, getUserIdOrRedirect } from "@/lib/auth-server";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { EnvironmentUI } from "@/components/environments/main";
import type { Metadata } from "next";
import { env } from "@terragon/env/apps-www";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const userId = await getUserIdOrNull();
  if (!userId) {
    return { title: "Environment | Terragon" };
  }
  const { id } = await params;
  const environment = await getEnvironment({
    db,
    environmentId: id,
    userId,
  });
  if (!environment) {
    return { title: "Environment | Terragon" };
  }
  return {
    title: `${environment.repoFullName} Environment | Terragon`,
  };
}

export default async function EnvironmentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // Auth + params in parallel so the environment fetch starts ~5-10ms sooner.
  const [userId, { id }] = await Promise.all([getUserIdOrRedirect(), params]);
  const environment = await getEnvironment({
    db,
    environmentId: id,
    userId,
  });
  if (!environment) {
    return notFound();
  }
  const [environmentVariables, mcpConfig, globalEnvironmentVariableKeys] =
    await Promise.all([
      getDecryptedEnvironmentVariables({
        db,
        userId,
        environmentId: id,
        encryptionMasterKey: env.ENCRYPTION_MASTER_KEY,
      }),
      getDecryptedMcpConfig({
        db,
        userId,
        environmentId: id,
        encryptionMasterKey: env.ENCRYPTION_MASTER_KEY,
      }),
      (async () => {
        const globalEnvironment = await getOrCreateGlobalEnvironment({
          db,
          userId,
        });
        return (
          globalEnvironment.environmentVariables?.map(
            (variable) => variable.key,
          ) ?? []
        );
      })(),
    ]);
  return (
    <EnvironmentUI
      environmentId={id}
      environment={environment}
      environmentVariables={environmentVariables}
      globalEnvironmentVariableKeys={globalEnvironmentVariableKeys}
      mcpConfig={mcpConfig || undefined}
      snapshots={environment.snapshots ?? []}
    />
  );
}
