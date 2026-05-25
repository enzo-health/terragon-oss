"use client";

import { useState } from "react";
import Image from "next/image";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { signInWithGithub } from "@/components/auth";
import { Wordmark } from "@/components/shared/wordmark";

type DevLoginResponse = {
  redirectTo?: string;
};

export default function Login({
  returnUrl,
  devLoginEnabled,
}: {
  returnUrl: string;
  devLoginEnabled: boolean;
}) {
  const [isGithubLoading, setIsGithubLoading] = useState(false);
  const [isDevLoginLoading, setIsDevLoginLoading] = useState(false);
  const [devLoginError, setDevLoginError] = useState<string | null>(null);

  const handleGithubSignIn = async () => {
    await signInWithGithub({
      setLoading: setIsGithubLoading,
      returnUrl,
      location: "login_page",
    });
  };

  const handleDevLogin = async () => {
    setDevLoginError(null);
    setIsDevLoginLoading(true);
    try {
      const response = await fetch("/api/auth/sign-in/dev-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ returnUrl }),
      });
      if (!response.ok) {
        throw new Error("Dev login failed");
      }
      const result = (await response.json()) as DevLoginResponse;
      window.location.href = result.redirectTo ?? returnUrl;
    } catch {
      setDevLoginError("Dev login failed");
    } finally {
      setIsDevLoginLoading(false);
    }
  };

  const isLoading = isGithubLoading || isDevLoginLoading;

  return (
    <div className="min-h-[100dvh] w-full bg-canvas flex items-center justify-center">
      <div className="flex w-full max-w-sm flex-col items-center justify-center p-6">
        <div className="w-full rounded-lg bg-raised p-8 shadow-card">
          <div className="flex flex-col items-center text-center gap-4">
            <Wordmark showLogo showText size="lg" />
            <div className="flex flex-col gap-1.5 pt-1">
              <h1 className="text-title font-semibold leading-tight text-strong">
                Sign in
              </h1>
              <p className="text-sm font-sans text-mid">
                Welcome back. Continue to Terragon.
              </p>
            </div>
          </div>

          <div className="mt-8 flex flex-col gap-4">
            <Button
              variant="default"
              size="lg"
              className="relative h-10 w-full font-sans font-medium active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-ring/50 transition-transform"
              onClick={handleGithubSignIn}
              disabled={isLoading}
            >
              {isGithubLoading ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Signing in
                </>
              ) : (
                <>
                  <Image
                    src="https://cdn.terragonlabs.com/github-mark-Z5SF.svg"
                    alt="GitHub"
                    width={20}
                    height={20}
                    className="absolute left-4 hidden dark:block"
                  />
                  <Image
                    src="https://cdn.terragonlabs.com/github-mark-white-Ue4J.svg"
                    alt="GitHub"
                    width={20}
                    height={20}
                    className="absolute left-4 block dark:hidden"
                  />
                  Continue with GitHub
                </>
              )}
            </Button>
            {devLoginEnabled ? (
              <Button
                variant="outline"
                size="lg"
                className="h-10 w-full font-sans font-medium active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-ring/50 transition-transform"
                onClick={handleDevLogin}
                disabled={isLoading}
              >
                {isDevLoginLoading ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Signing in
                  </>
                ) : (
                  "Dev Login"
                )}
              </Button>
            ) : null}
            {devLoginError ? (
              <p className="text-sm text-center text-destructive font-sans">
                {devLoginError}
              </p>
            ) : null}
            <p className="text-micro text-center text-mid font-sans tracking-[0.06em] uppercase">
              Secure authentication via GitHub
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
