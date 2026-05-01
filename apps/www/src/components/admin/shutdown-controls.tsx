import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertTriangle } from "lucide-react";

const INTERNAL_TENANT_NOTICE =
  "Shutdown tooling is disabled in internal single-tenant mode.";

export function ShutdownControls() {
  return (
    <div className="container mx-auto max-w-2xl py-8">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-error" />
            Shutdown controls
          </CardTitle>
          <CardDescription>
            Manage the Terragon shutdown workflow in single-tenant deployments.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Warning</AlertTitle>
            <AlertDescription>{INTERNAL_TENANT_NOTICE}</AlertDescription>
          </Alert>

          <div className="space-y-3">
            <h3 className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
              Shutdown actions
            </h3>
            <dl className="divide-y divide-border rounded-xl border border-border">
              <div className="flex items-baseline justify-between gap-4 px-4 py-3 text-sm">
                <dt className="text-foreground">
                  Automatic account deprovisioning
                </dt>
                <dd className="text-muted-foreground">No longer available</dd>
              </div>
              <div className="flex items-baseline justify-between gap-4 px-4 py-3 text-sm">
                <dt className="text-foreground">
                  Timed shutdown orchestration
                </dt>
                <dd className="text-muted-foreground">Disabled</dd>
              </div>
            </dl>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
