"use client";

import { useState } from "react";
import Image from "next/image";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { signInWithGithub } from "@/components/auth";
import { Wordmark } from "@/components/shared/wordmark";

export default function Login({ returnUrl }: { returnUrl: string }) {
  const [isLoading, setIsLoading] = useState(false);

  const handleGithubSignIn = async () => {
    await signInWithGithub({
      setLoading: setIsLoading,
      returnUrl,
      location: "login_page",
    });
  };

  return (
    <div className="min-h-[100dvh] w-full bg-canvas flex items-center justify-center">
      <div className="flex flex-col p-8 items-center justify-center w-full max-w-md">
        <div className="w-full space-y-10 bg-raised p-12 rounded-[1.25rem] shadow-card">
          <div className="flex flex-col items-center text-center space-y-5">
            <Wordmark showLogo showText size="lg" />
            <div className="space-y-2 pt-3">
              <h1 className="text-display font-display font-[300] tracking-tight leading-tight text-strong">
                Sign in
              </h1>
              <p className="text-lead font-sans text-mid">
                Welcome back. Continue to Terragon.
              </p>
            </div>
          </div>

          <div className="space-y-5">
            <Button
              variant="default"
              size="lg"
              className="w-full h-12 rounded-full relative font-sans font-medium active:scale-[0.98] focus-visible:ring-2 focus-visible:ring-ring/50 transition-transform"
              onClick={handleGithubSignIn}
              disabled={isLoading}
            >
              {isLoading ? (
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
                    className="hidden dark:block absolute left-6"
                  />
                  <Image
                    src="https://cdn.terragonlabs.com/github-mark-white-Ue4J.svg"
                    alt="GitHub"
                    width={20}
                    height={20}
                    className="block dark:hidden absolute left-6"
                  />
                  Continue with GitHub
                </>
              )}
            </Button>
            <p className="text-micro text-center text-mid font-sans tracking-[0.06em] uppercase">
              Secure authentication via GitHub
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
