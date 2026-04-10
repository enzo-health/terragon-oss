import { getUserIdOrNull, getUserIdOrRedirect } from "@/lib/auth-server";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { getEnvironment } from "@leo/shared/model/environments";
import type { Metadata } from "next";
import { SetupScriptEditor } from "@/components/environments/setup-script-editor";

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const userId = await getUserIdOrNull();
  if (!userId) {
    return { title: "Setup Script | Leo" };
  }
  const { id } = await params;
  const environment = await getEnvironment({
    db,
    environmentId: id,
    userId,
  });
  if (!environment) {
    return { title: "Setup Script | Leo" };
  }
  return {
    title: `${environment.repoFullName} Setup Script | Leo`,
  };
}

export default async function SetupScriptPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const userId = await getUserIdOrRedirect();
  const { id } = await params;
  const environment = await getEnvironment({
    db,
    environmentId: id,
    userId,
  });
  if (!environment) {
    return notFound();
  }

  return <SetupScriptEditor environmentId={id} environment={environment} />;
}
