"use client";

import type { AuthType } from "@/lib/claude-oauth";
import { getAuthorizationURL } from "@/server-actions/claude-oauth";
import { useRouter } from "next/navigation";
import { useState, useEffect } from "react";

export function ClaudeRedirect({ type }: { type: AuthType }) {
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  useEffect(() => {
    const handleRedirect = async () => {
      try {
        // Get the authorization URL from the server
        const result = await getAuthorizationURL({ type });
        if (!result.success || !result.data) {
          setError("Failed to initialize OAuth flow");
          // Notify the parent window of the error
          if (window.opener) {
            window.opener.postMessage(
              {
                type: "claude-oauth-error",
                error: "Failed to initialize OAuth flow",
              },
              window.location.origin,
            );
            window.close();
          } else {
            // If no opener, redirect to settings with error
            router.push("/settings?error=oauth_init_failed");
          }
          return;
        }

        // Send the code verifier to the parent window before redirecting
        if (window.opener) {
          window.opener.postMessage(
            {
              type: "claude-oauth-started",
              codeVerifier: result.data.codeVerifier,
            },
            window.location.origin,
          );
        }

        // Make sure the parent window has received the message before redirecting
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Redirect to Claude OAuth page
        window.location.href = result.data.url.toString();
      } catch (error) {
        console.error("OAuth redirect error:", error);
        setError("An error occurred during OAuth redirect");

        // Notify parent window of error
        if (window.opener) {
          window.opener.postMessage(
            {
              type: "claude-oauth-error",
              error: "An error occurred during OAuth redirect",
            },
            window.location.origin,
          );
          setTimeout(() => window.close(), 2000);
        } else {
          router.push("/settings?error=oauth_redirect_failed");
        }
      }
    };

    handleRedirect();
  }, [router, type]);

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="text-center">
        {error ? (
          <>
            <h1 className="text-xl font-semibold text-error mb-2">Error</h1>
            <p className="text-muted-foreground">{error}</p>
            <p className="text-sm text-muted-foreground mt-2">
              This window will close automatically...
            </p>
          </>
        ) : (
          <>
            <h1 className="text-xl font-semibold mb-2">
              Redirecting to Claude...
            </h1>
            <p className="text-muted-foreground">
              Please wait while we redirect you to authenticate.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
