"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { AlertCircle, Home, RotateCcw } from "lucide-react";
import Link from "next/link";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center p-4 w-full">
      <div className="w-full max-w-md">
        <div className="flex flex-col items-center gap-6 text-center">
          {/* Error Icon */}
          <div className="flex size-20 items-center justify-center rounded-full bg-destructive/10">
            <AlertCircle className="size-10 text-destructive" />
          </div>

          {/* Error Message */}
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold">Something went wrong</h1>
            <p className="text-muted-foreground">
              We encountered an unexpected error. Our team has been notified and
              is working to fix it.
            </p>
          </div>

          {/* Error Details (in development) */}
          {process.env.NODE_ENV === "development" && (
            <div className="w-full rounded-md border border-destructive/20 bg-destructive/5 p-4">
              <p className="mb-2 text-xs font-medium text-destructive">
                Error Details
              </p>
              <p className="break-words font-mono text-xs text-muted-foreground">
                {error.message || "Unknown error"}
              </p>
              {error.digest && (
                <p className="mt-1 font-mono text-xs text-muted-foreground opacity-60">
                  ID: {error.digest}
                </p>
              )}
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-3">
            <Button onClick={reset} variant="default" className="gap-2">
              <RotateCcw className="size-4" />
              Try again
            </Button>
            <Button variant="outline" asChild>
              <Link href="/" className="gap-2">
                <Home className="size-4" />
                Go home
              </Link>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
