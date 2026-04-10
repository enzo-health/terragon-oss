import { db } from "@/lib/db";
import { getAdminUserOrThrow } from "@/lib/auth-server";
import { getActiveSandboxCount } from "@/server-actions/admin/sandbox";
import { getThreadsForAdmin } from "@leo/shared/model/threads";
import { SandboxesContent } from "@/components/admin/sandboxes-content";
import { Card, CardContent } from "@/components/ui/card";

export default async function AdminSandboxesPage() {
  await getAdminUserOrThrow();
  const [count, activeThreads] = await Promise.all([
    (async () => {
      try {
        const count = await getActiveSandboxCount();
        return count;
      } catch (error) {
        console.error("Failed to fetch sandbox count:", error);
        return null;
      }
    })(),
    getThreadsForAdmin({
      db,
      limit: 100,
      status: [
        "booting",
        "working",
        "stopping",
        "working-error",
        "working-done",
        "checkpointing",
      ],
    }),
  ]);
  if (typeof count !== "number") {
    return (
      <div className="space-y-6">
        <h1 className="text-3xl font-bold">Active Sandboxes</h1>
        <Card>
          <CardContent className="py-8">
            <p className="text-center text-red-600">
              Failed to fetch sandbox data. Please check your E2B API key
              configuration.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }
  return <SandboxesContent count={count} activeThreads={activeThreads} />;
}
