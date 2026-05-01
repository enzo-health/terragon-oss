import dynamic from "next/dynamic";
import { getUserIdOrRedirect } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { getEnvironments } from "@terragon/shared/model/environments";
import type { Metadata } from "next";
import { Skeleton } from "@/components/ui/skeleton";

export const metadata: Metadata = {
  title: "Environments | Terragon",
};

// Dynamically import the heavy environments component for code splitting.
// The skeleton previews the eventual layout (header row + repo list rows) so
// the swap to real content doesn't reflow.
const Environments = dynamic(
  () => import("@/components/environments/main").then((m) => m.Environments),
  {
    loading: () => (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 py-8">
        <div className="flex items-center justify-between gap-4">
          <Skeleton className="h-7 w-40" />
          <Skeleton className="h-9 w-32 rounded-full" />
        </div>
        <div className="flex flex-col gap-2">
          <Skeleton className="h-14 w-full rounded-xl" />
          <Skeleton className="h-14 w-full rounded-xl" />
          <Skeleton className="h-14 w-full rounded-xl" />
          <Skeleton className="h-14 w-full rounded-xl" />
        </div>
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
