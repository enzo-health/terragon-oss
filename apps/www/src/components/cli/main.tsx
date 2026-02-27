"use client";

import { useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { createCliApiToken } from "@/server-actions/cli-api-token";
import { CodeClickToCopy } from "@/components/ui/code";
import { Loader2, Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Wordmark } from "../shared/wordmark";
import { unwrapResult } from "@/lib/server-actions";

type Status = "initial" | "loading" | "success" | "error";

export function CLIAuth({ cliPort }: { cliPort: number }) {
  const [status, setStatus] = useState<Status>("initial");
  const [apiKey, setApiKey] = useState<string>("");

  const attemptCliAuth = async (e: React.MouseEvent) => {
    e.preventDefault();
    try {
      setStatus("loading");
      const apiKey = unwrapResult(await createCliApiToken());
      setApiKey(apiKey);

      // Attempt to POST the API key to the CLI port
      const response = await fetch(`http://localhost:${cliPort}/auth`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ apiKey }),
        // Short timeout since this is a local request
        signal: AbortSignal.timeout(3000),
      });
      if (response.ok) {
        setStatus("success");
        // Auto-close the window after a short delay
        setTimeout(() => {
          window.close();
        }, 2000);
      } else {
        throw new Error("CLI auth endpoint returned error");
      }
    } catch (error) {
      // If the POST fails, show the manual copy UI
      setStatus("error");
    }
  };

  if (status === "initial") {
    return (
      <div className="flex min-h-screen items-center justify-center p-4 w-full">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto relative mb-4 flex w-fit items-center justify-center rounded-full bg-primary/10 p-4">
              <Terminal className="size-8 text-primary" />
              <div className="absolute flex items-center justify-center -bottom-2 -right-2 p-1.5 bg-background rounded-full">
                <Wordmark showText={false} />
              </div>
            </div>
            <CardTitle>Authorize CLI</CardTitle>
            <CardDescription>
              Click the button below to authenticate this CLI client
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              onClick={attemptCliAuth}
              className="w-full"
              size="lg"
              type="button"
            >
              Authorize CLI
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (status === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center p-4 w-full">
        <Card className="w-full max-w-md">
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Loader2 className="mb-4 h-8 w-8 animate-spin" />
            <p className="text-center text-lg">
              Please wait while we authorize the CLI client
            </p>
            <p className="mt-2 text-center text-sm text-muted-foreground">
              Connecting to CLI...
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (status === "success") {
    return (
      <div className="flex min-h-screen items-center justify-center p-4 w-full">
        <Card className="w-full max-w-md">
          <CardContent className="flex flex-col items-center justify-center py-12">
            <div className="mb-4 text-green-600">
              <svg
                className="h-12 w-12"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 13l4 4L19 7"
                />
              </svg>
            </div>
            <p className="text-center text-lg font-semibold">
              Successfully authenticated!
            </p>
            <p className="mt-2 text-center text-sm text-muted-foreground">
              You can close this window.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Error state - show manual copy UI
  return (
    <div className="flex min-h-screen items-center justify-center p-4 w-full">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>
            Copy the API key below and paste it into your CLI:
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <div className="rounded-md bg-muted p-4 text-center truncate cursor-pointer">
              <CodeClickToCopy
                text={apiKey}
                className="break-all text-sm truncate"
              />
            </div>
          </div>
          <div className="text-sm text-muted-foreground">
            <p className="mb-1 font-semibold">To complete authentication:</p>
            <ol className="list-inside list-decimal space-y-1">
              <li>Click the API key above to copy it</li>
              <li>Return to your terminal</li>
              <li>Paste the API key when prompted</li>
            </ol>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
