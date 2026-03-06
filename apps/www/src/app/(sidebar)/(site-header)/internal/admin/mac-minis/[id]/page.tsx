import { getAdminUserOrThrow } from "@/lib/auth-server";
import { getMacMiniWorkerDetail } from "@/server-actions/admin/mac-mini";
import { MacMiniDetail } from "@/components/admin/mac-mini-detail";
import { notFound } from "next/navigation";

export default async function AdminMacMiniDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await getAdminUserOrThrow();
  const { id } = await params;
  const worker = await getMacMiniWorkerDetail(id);
  if (!worker) {
    notFound();
  }
  return <MacMiniDetail worker={worker} />;
}
