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
    <div className="min-h-[100dvh] w-full bg-background flex items-center justify-center">
      <div className="flex flex-col p-8 items-center justify-center w-full max-w-md">
        <div className="w-full space-y-12 bg-card p-12 rounded-3xl shadow-card border border-border/40">
          <div className="flex flex-col items-center text-center space-y-4">
            <Wordmark showLogo showText size="lg" />
            <div className="space-y-2 pt-4">
              <h1 className="text-[36px] font-display font-[300] tracking-tight leading-tight text-foreground">
                Sign in
              </h1>
              <p className="text-[15px] font-sans text-muted-foreground/70 tracking-[0.15px]">
                Welcome back. Sign in to continue to Terragon.
              </p>
            </div>
          </div>

          <div className="space-y-6">
            <Button
              variant="default"
              size="lg"
              className="w-full h-12 rounded-full relative font-sans font-medium tracking-[0.15px]"
              onClick={handleGithubSignIn}
              disabled={isLoading}
            >
              {isLoading ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Signing in...
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
            <p className="text-[11px] text-center text-muted-foreground/50 font-sans tracking-[0.02em] uppercase">
              Secure authentication via GitHub
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
