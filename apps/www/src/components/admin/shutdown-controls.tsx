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
    <div className="container mx-auto py-8 max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-destructive" />
            Shutdown Controls
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

          <div className="space-y-4">
            <h3 className="font-medium">Shutdown actions</h3>
            <div className="space-y-2 text-sm text-muted-foreground">
              <p>
                <span className="font-medium">
                  Automatic account deprovisioning
                </span>
                —No longer available.
              </p>
              <p>
                <span className="font-medium">
                  Timed shutdown orchestration
                </span>
                —Disabled.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
