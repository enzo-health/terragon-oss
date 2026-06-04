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
import { Check, Loader2, Terminal } from "lucide-react";
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
      <div className="flex min-h-svh items-center justify-center p-4 w-full">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <div className="mx-auto relative mb-4 flex w-fit items-center justify-center rounded-full bg-coral/10 p-4">
              <Terminal className="size-8 text-coral" />
              <div className="absolute flex items-center justify-center -bottom-2 -right-2 p-1.5 bg-canvas rounded-full">
                <Wordmark showText={false} />
              </div>
            </div>
            <CardTitle>Authorize CLI</CardTitle>
            <CardDescription>
              Click the button below to authenticate this CLI client.
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
      <div className="flex min-h-svh items-center justify-center p-4 w-full">
        <Card className="w-full max-w-md">
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Loader2 className="mb-4 h-8 w-8 animate-spin text-coral" />
            <p className="text-center text-lg">Authorizing the CLI client</p>
            <p className="mt-2 text-center text-sm text-mid">
              Connecting to CLI…
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  if (status === "success") {
    return (
      <div className="flex min-h-svh items-center justify-center p-4 w-full">
        <Card className="w-full max-w-md">
          <CardContent className="flex flex-col items-center justify-center py-12">
            <div className="mb-4 flex size-12 items-center justify-center rounded-full bg-success/10 text-success">
              <Check className="size-6" />
            </div>
            <p className="text-center text-lg font-semibold">
              Successfully authenticated
            </p>
            <p className="mt-2 text-center text-sm text-mid">
              You can close this window.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  // Error state - show manual copy UI
  return (
    <div className="flex min-h-svh items-center justify-center p-4 w-full">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>Finish authentication manually</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <div className="rounded-xl bg-sunken p-4 text-center truncate cursor-pointer">
              <CodeClickToCopy
                text={apiKey}
                className="break-all text-sm truncate"
              />
            </div>
          </div>
          <div className="text-sm text-mid">
            <p className="mb-1 font-semibold text-strong">
              To complete authentication
            </p>
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
