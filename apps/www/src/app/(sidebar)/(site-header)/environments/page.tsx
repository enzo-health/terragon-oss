import dynamic from "next/dynamic";
import { getUserIdOrRedirect } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { getEnvironments } from "@terragon/shared/model/environments";
import type { Metadata } from "next";
import { Skeleton } from "@/components/ui/skeleton";

export const metadata: Metadata = {
  title: "Environments | Terragon",
};

// Dynamically import the heavy environments component for code splitting
const Environments = dynamic(
  () => import("@/components/environments/main").then((m) => m.Environments),
  {
    loading: () => (
      <div className="flex flex-col gap-4 p-4">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    ),
  },
);

export default async function EnvironmentsPage() {
  const userId = await getUserIdOrRedirect();
  const environments = await getEnvironments({
    db,
    userId,
    includeGlobal: false,
  });
  return <Environments environments={environments} />;
}
