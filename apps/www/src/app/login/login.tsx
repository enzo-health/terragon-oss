"use client";

import { type FormEvent, useState } from "react";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { signInWithGithub } from "@/components/auth";
import { Wordmark } from "@/components/shared/wordmark";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

export default function Login({ returnUrl }: { returnUrl: string }) {
  const [isGithubLoading, setIsGithubLoading] = useState(false);
  const [isPasswordLoading, setIsPasswordLoading] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);

  const handleGithubSignIn = async () => {
    await signInWithGithub({
      setLoading: setIsGithubLoading,
      returnUrl,
      location: "login_page",
    });
  };

  const handlePasswordSignIn = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAuthError(null);
    setIsPasswordLoading(true);

    try {
      const result = await authClient.signIn.email({
        email: email.trim(),
        password,
        callbackURL: returnUrl,
      });

      if (result.error) {
        setAuthError(result.error.message ?? "Unable to sign in");
      }
    } catch {
      setAuthError("Unable to sign in");
    } finally {
      setIsPasswordLoading(false);
    }
  };

  const disablePasswordSubmit =
    isPasswordLoading || email.trim().length === 0 || password.length === 0;

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

          <form onSubmit={handlePasswordSignIn} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                disabled={isPasswordLoading}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Enter your password"
                disabled={isPasswordLoading}
              />
            </div>
            {authError ? (
              <p className="text-sm text-destructive" role="alert">
                {authError}
              </p>
            ) : null}
            <Button
              type="submit"
              variant="outline"
              size="lg"
              className="w-full"
              disabled={disablePasswordSubmit}
            >
              {isPasswordLoading ? "Signing in..." : "Sign in with Email"}
            </Button>
          </form>
          <div className="space-y-4">
            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t" />
              </div>
              <div className="relative flex justify-center text-xs uppercase">
                <span className="bg-background px-2 text-muted-foreground">
                  Or continue with
                </span>
              </div>
            </div>
            <Button
              variant="default"
              size="lg"
              className="w-full relative"
              onClick={handleGithubSignIn}
              disabled={isGithubLoading}
            >
              {isGithubLoading ? (
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
