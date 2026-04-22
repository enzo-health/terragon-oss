import { Button } from "../ui/button";
import { RotateCcw, GitBranch, Loader2 } from "lucide-react";
import { Thread, ThreadErrorType } from "@terragon/shared";
import Link from "next/link";
import { isAgentWorking } from "@/agent/thread-status";
import { useTheme } from "next-themes";
import { ansiToHtml } from "./tools/utils";

const ERROR_TYPES_THAT_HIDE_RETRY_BUTTON = new Set<ThreadErrorType>([
  "no-user-message",
  "prompt-too-long",
]);

/**
 * Error types that originate from the sandbox boot / connect pipeline.
 * Used to suppress the "Assistant is working" footer when one of these is
 * the latest error on the thread: the sandbox clearly is NOT running and
 * showing two contradictory signals confuses users.
 */
const SANDBOX_ERROR_TYPES = new Set<ThreadErrorType>([
  "sandbox-not-found",
  "sandbox-creation-failed",
  "sandbox-resume-failed",
]);

export function isSandboxErrorType(
  errorType: string | null | undefined,
): boolean {
  if (!errorType) return false;
  return SANDBOX_ERROR_TYPES.has(errorType as ThreadErrorType);
}

export function ChatError({
  errorType,
  errorInfo,
  status,
  handleRetry,
  isReadOnly,
  isRetrying,
}: {
  errorType: Thread["errorMessage"];
  errorInfo: Thread["errorMessageInfo"];
  status: Thread["status"];
  handleRetry: () => Promise<void>;
  isReadOnly: boolean;
  isRetrying?: boolean;
}) {
  const showRetryButton = !!(
    errorType &&
    !ERROR_TYPES_THAT_HIDE_RETRY_BUTTON.has(errorType as ThreadErrorType) &&
    !isAgentWorking(status) &&
    !isReadOnly
  );
  return (
    <div className="p-2 border border-destructive bg-destructive/10 rounded-md text-sm animate-in fade-in slide-in-from-bottom-1 duration-200">
      <div className="flex gap-2 mb-1 justify-between items-start">
        <div className="min-w-0 flex-1">
          <ChatContent errorType={errorType} errorInfo={errorInfo} />
        </div>
        {showRetryButton && (
          <Button
            onClick={handleRetry}
            size="icon"
            variant="ghost"
            className="size-6 hover:bg-transparent hover:text-foreground flex-shrink-0"
            title="Retry"
            aria-label="Retry"
            disabled={isRetrying}
          >
            {isRetrying ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RotateCcw className="size-4" />
            )}
          </Button>
        )}
      </div>
    </div>
  );
}

function ChatErrorContents({
  header,
  body,
}: {
  header: React.ReactNode;
  body: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 font-mono">
      <p className="text-xs font-medium flex items-center gap-1">{header}</p>
      <div className="text-xs text-muted-foreground">{body}</div>
    </div>
  );
}

function ChatErrorContentsWithPre({
  header,
  errorStr,
  renderAnsi = false,
}: {
  header: React.ReactNode;
  errorStr: string | null;
  renderAnsi?: boolean;
}) {
  const { resolvedTheme } = useTheme();
  const theme = resolvedTheme === "light" ? "light" : "dark";

  return (
    <div className="flex flex-col gap-2 font-mono">
      <p className="text-xs font-medium flex items-center gap-1">{header}</p>
      {errorStr && (
        <div className="text-xs text-muted-foreground">
          {renderAnsi ? (
            <pre
              className="whitespace-pre-wrap break-words overflow-hidden"
              dangerouslySetInnerHTML={{
                __html: ansiToHtml(errorStr, theme),
              }}
            />
          ) : (
            <pre className="whitespace-pre-wrap break-words overflow-hidden">
              {errorStr}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function ChatContent({
  errorType,
  errorInfo,
}: {
  errorType: Thread["errorMessage"];
  errorInfo: Thread["errorMessageInfo"];
}) {
  const errorTypeStrict = errorType as ThreadErrorType;
  switch (errorTypeStrict) {
    case "invalid-claude-credentials": {
      return (
        <ChatErrorContents
          header="Claude credentials expired"
          body={
            <>
              Please update your Claude credentials to continue. Go to{" "}
              <Link
                href="/settings/agent#agent-providers"
                className="underline"
              >
                settings
              </Link>{" "}
              to update your credentials.
            </>
          }
        />
      );
    }
    case "missing-gemini-credentials": {
      return (
        <ChatErrorContents
          header="Gemini API key required"
          body={
            <>
              Please add your Gemini API key to continue. Go to{" "}
              <Link
                href="/settings/agent#agent-providers"
                className="underline"
              >
                settings
              </Link>{" "}
              to add your API key.
            </>
          }
        />
      );
    }
    case "missing-amp-credentials": {
      return (
        <ChatErrorContents
          header="Amp API key required"
          body={
            <>
              Please add your Amp API key to continue. Go to{" "}
              <Link
                href="/settings/agent#agent-providers"
                className="underline"
              >
                settings
              </Link>{" "}
              to add your API key.
            </>
          }
        />
      );
    }
    case "chatgpt-sub-required": {
      return (
        <ChatErrorContents
          header="ChatGPT account required"
          body={
            <>
              This model requires a connected ChatGPT account. Choose a
              different model or connect your ChatGPT account to continue. Go to{" "}
              <Link
                href="/settings/agent#agent-providers"
                className="underline"
              >
                settings
              </Link>{" "}
              to connect your account.
            </>
          }
        />
      );
    }
    case "invalid-codex-credentials": {
      return (
        <ChatErrorContents
          header="OpenAI credentials expired"
          body={
            <>
              Please update your OpenAI credentials to continue. Go to{" "}
              <Link
                href="/settings/agent#agent-providers"
                className="underline"
              >
                settings
              </Link>{" "}
              to update your credentials.
            </>
          }
        />
      );
    }
    case "git-checkpoint-diff-failed": {
      return (
        <ChatErrorContentsWithPre
          header={
            <>
              <GitBranch className="size-3" /> Git checkpoint failed
            </>
          }
          errorStr={errorInfo}
        />
      );
    }
    case "git-checkpoint-push-failed": {
      return (
        <ChatErrorContentsWithPre
          header={
            <>
              <GitBranch className="size-3" /> Git push failed
            </>
          }
          errorStr={errorInfo}
        />
      );
    }
    case "request-timeout": {
      return (
        <ChatErrorContents
          header="Request timed out"
          body={
            <>
              The request took too long to complete. This is usually transient —
              retry to try again.
            </>
          }
        />
      );
    }
    case "no-user-message": {
      return (
        <ChatErrorContentsWithPre
          header="No user message found"
          errorStr={errorInfo}
        />
      );
    }
    case "unknown-error": {
      // Keep the honest default: we don't have finer classification for
      // this bucket, so the friendliest thing we can do is stop pretending
      // we know what happened and offer a retry.
      return (
        <ChatErrorContents
          header="Something went wrong"
          body={
            <>
              We couldn&apos;t complete the request. Retry to try again.
              {errorInfo ? (
                <details className="mt-2 text-muted-foreground/80">
                  <summary className="cursor-pointer select-none">
                    Details
                  </summary>
                  <pre className="whitespace-pre-wrap break-words overflow-hidden mt-1">
                    {errorInfo}
                  </pre>
                </details>
              ) : null}
            </>
          }
        />
      );
    }
    case "sandbox-not-found": {
      return (
        <ChatErrorContents
          header="Couldn't connect to sandbox"
          body={
            <>
              The sandbox for this task is no longer available. Retry to
              provision a fresh sandbox and continue.
            </>
          }
        />
      );
    }
    case "sandbox-creation-failed": {
      return (
        <ChatErrorContents
          header="Couldn't start sandbox"
          body={
            <>
              We couldn&apos;t create a sandbox for this task. This is usually a
              transient provider issue — retry to try again. If it keeps
              failing, check the{" "}
              <Link
                href="https://isanthropicdown.com"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:no-underline"
              >
                status page
              </Link>
              .
              {errorInfo ? (
                <details className="mt-2 text-muted-foreground/80">
                  <summary className="cursor-pointer select-none">
                    Details
                  </summary>
                  <pre className="whitespace-pre-wrap break-words overflow-hidden mt-1">
                    {errorInfo}
                  </pre>
                </details>
              ) : null}
            </>
          }
        />
      );
    }
    case "sandbox-resume-failed": {
      return (
        <ChatErrorContents
          header="Couldn't resume sandbox"
          body={
            <>
              The sandbox failed to come back online. Retry to create a fresh
              one and continue where you left off.
              {errorInfo ? (
                <details className="mt-2 text-muted-foreground/80">
                  <summary className="cursor-pointer select-none">
                    Details
                  </summary>
                  <pre className="whitespace-pre-wrap break-words overflow-hidden mt-1">
                    {errorInfo}
                  </pre>
                </details>
              ) : null}
            </>
          }
        />
      );
    }
    case "agent-not-responding":
      return (
        <ChatErrorContentsWithPre
          header="Agent did not respond. Please try again."
          errorStr={errorInfo}
        />
      );
    case "agent-generic-error": {
      return (
        <ChatErrorContentsWithPre
          header="Agent exited with an error"
          errorStr={errorInfo}
          renderAnsi
        />
      );
    }
    case "setup-script-failed": {
      return (
        <ChatErrorContentsWithPre
          header="terragon-setup.sh failed"
          errorStr={errorInfo}
          renderAnsi
        />
      );
    }
    case "prompt-too-long": {
      return (
        <ChatErrorContents
          header="Context window full"
          body={
            <>
              The context window is too long. Run `/compact` to clear the
              compress the context window.
            </>
          }
        />
      );
    }
    case "queue-limit-exceeded": {
      return (
        <ChatErrorContentsWithPre
          header="Task queue limit reached. Please try again later."
          errorStr={errorInfo}
        />
      );
    }
    default: {
      const _exhaustiveCheck: never = errorTypeStrict;
      console.log("Unhandled error", _exhaustiveCheck);
    }
    // TODO: make typescript error here if non-exhaustive
  }

  // Backwards compatibility
  if (errorType || errorInfo) {
    const errorStr = [errorType, errorInfo].filter(Boolean).join("\n\n");
    return (
      <ChatErrorContentsWithPre
        header="An error occurred"
        errorStr={errorStr}
      />
    );
  }

  return (
    <ChatErrorContentsWithPre
      header="An unexpected error occurred"
      errorStr={null}
    />
  );
}
