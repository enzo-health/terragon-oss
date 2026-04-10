import {
  getDecryptedEnvironmentVariables,
  getOrCreateGlobalEnvironment,
} from "@leo/shared/model/environments";
import { getUserIdOrRedirect } from "@/lib/auth-server";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { GlobalEnvironmentUI } from "@/components/environments/main";
import type { Metadata } from "next";
import { env } from "@leo/env/apps-www";

export async function generateMetadata(): Promise<Metadata> {
  return {
    title: `Global Environment | Leo`,
  };
}

export default async function EnvironmentPage() {
  const userId = await getUserIdOrRedirect();
  const environment = await getOrCreateGlobalEnvironment({ db, userId });
  if (!environment) {
    return notFound();
  }
  const environmentVariables = await getDecryptedEnvironmentVariables({
    db,
    userId,
    environmentId: environment.id,
    encryptionMasterKey: env.ENCRYPTION_MASTER_KEY,
  });
  return (
    <GlobalEnvironmentUI
      environmentId={environment.id}
      environmentVariables={environmentVariables}
    />
  );
}
