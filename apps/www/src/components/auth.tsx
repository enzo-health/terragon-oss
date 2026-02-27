"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth-client";
import { MagicLinkSignInButton } from "./magic-link-auth";
import posthog from "posthog-js";
import Image from "next/image";
import { cn } from "@/lib/utils";

type Location = "header" | "header_mobile_menu" | "login_page";

export async function signOut() {
  await authClient.signOut({
    fetchOptions: {
      onSuccess: () => {
        window.location.href = "/";
      },
    },
  });
}

export async function signInWithGithub({
  setLoading,
  returnUrl,
  location,
}: {
  setLoading?: (loading: boolean) => void;
  returnUrl?: string;
  location?: Location;
}) {
  const callbackURL = returnUrl
    ? `/login?returnUrl=${encodeURIComponent(returnUrl)}`
    : "/";

  posthog.capture("signin_github_clicked", { location });

  await authClient.signIn.social(
    {
      provider: "github",
      callbackURL,
      scopes: ["repo", "workflow"],
    },
    {
      onRequest: (_ctx) => {
        setLoading?.(true);
      },
      onResponse: (_ctx) => {
        setLoading?.(false);
      },
    },
  );
}

export function SignInGithhubButton({
  location,
  labelOverride,
  className,
}: {
  location: Location;
  labelOverride?: string;
  className?: string;
}) {
  const [loading, setLoading] = useState(false);
  const onClick = async () => {
    await signInWithGithub({ setLoading, location });
  };

  if (location === "header" || location === "header_mobile_menu") {
    return (
      <Button
        variant="default"
        disabled={loading}
        className={cn("cursor-pointer", className)}
        size="lg"
        onClick={onClick}
      >
        {labelOverride || "Sign In"}
      </Button>
    );
  }
  return (
    <Button
      variant="default"
      disabled={loading}
      className={cn("cursor-pointer", className)}
      size="lg"
      onClick={onClick}
    >
      <Image
        src="https://cdn.terragonlabs.com/github-mark-Z5SF.svg"
        alt="GitHub"
        width={18}
        height={18}
        className="hidden dark:block"
      />
      <Image
        src="https://cdn.terragonlabs.com/github-mark-white-Ue4J.svg"
        alt="GitHub"
        width={18}
        height={18}
        className="block dark:hidden"
      />
      <span className="hidden sm:block">Sign In with GitHub</span>
      <span className="block sm:hidden">Sign In</span>
    </Button>
  );
}

export function SignInButtonForPreview() {
  if (process.env.NEXT_PUBLIC_VERCEL_ENV !== "preview") {
    return null;
  }
  return (
    <div className="flex justify-center p-8">
      <MagicLinkSignInButton />
    </div>
  );
}
