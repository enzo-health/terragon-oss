"use client";

import { useState } from "react";
import Image from "next/image";
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
    <div className="min-h-[100dvh] w-full">
      <div className="flex flex-col p-6 md:p-12 items-center justify-center">
        <div className="w-full max-w-sm space-y-8">
          <div className="flex flex-col items-center text-center space-y-2">
            <Wordmark showLogo showText size="lg" />
            <h1 className="text-2xl font-semibold tracking-tight mt-6">
              Sign in
            </h1>
            <p className="text-sm text-muted-foreground">Sign in to continue</p>
          </div>

          <div className="space-y-4">
            <Button
              variant="default"
              size="lg"
              className="w-full relative"
              onClick={handleGithubSignIn}
              disabled={isLoading}
            >
              {isLoading ? (
                "Signing in..."
              ) : (
                <>
                  <Image
                    src="https://cdn.terragonlabs.com/github-mark-Z5SF.svg"
                    alt="GitHub"
                    width={20}
                    height={20}
                    className="hidden dark:block absolute left-4"
                  />
                  <Image
                    src="https://cdn.terragonlabs.com/github-mark-white-Ue4J.svg"
                    alt="GitHub"
                    width={20}
                    height={20}
                    className="block dark:hidden absolute left-4"
                  />
                  Continue with GitHub
                </>
              )}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
