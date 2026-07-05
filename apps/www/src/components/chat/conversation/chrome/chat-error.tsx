import { Thread, ThreadErrorType } from "@terragon/shared";
import { GitBranch, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useTheme } from "next-themes";
import { isAgentWorking } from "@/agent/thread-status";
import { Button } from "@/components/ai/button";
import { Callout, CalloutContent } from "@/components/ai/callout";
import {
  Exception,
  ExceptionContent,
  ExceptionFrames,
  ExceptionHeader,
  ExceptionTrigger,
} from "@/components/ai/exception";
import { ansiToHtml } from "../../tools/utils";

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

// Membership guard. ThreadErrorMessage is `ThreadErrorType | string`, so the
// banner may receive an arbitrary string ("runtime", a free-form message, an
// unmapped code). Narrow to a real ThreadErrorType so the ChatContent switch is
// exhaustive over a closed union. Mirrors the union in
// packages/shared/src/db/types.ts (18 members).
const KNOWN_THREAD_ERROR_TYPES = new Set<ThreadErrorType>([
  "request-timeout",
  "no-user-message",
  "unknown-error",
  "sandbox-not-found",
  "sandbox-creation-failed",
  "sandbox-resume-failed",
  "missing-gemini-credentials",
  "missing-amp-credentials",
  "chatgpt-sub-required",
  "invalid-codex-credentials",
  "invalid-claude-credentials",
  "agent-not-responding",
  "agent-generic-error",
  "git-checkpoint-diff-failed",
  "git-checkpoint-push-failed",
  "setup-script-failed",
  "prompt-too-long",
  "queue-limit-exceeded",
]);

function normalizeChatErrorType(
  errorType: Thread["errorMessage"],
): ThreadErrorType | null {
  if (!errorType) return null;
  return KNOWN_THREAD_ERROR_TYPES.has(errorType as ThreadErrorType)
    ? (errorType as ThreadErrorType)
    : null;
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
    <Callout
      tone="danger"
      role="alert"
      className="animate-in fade-in slide-in-from-bottom-1 duration-200"
    >
      <CalloutContent>
        <ChatContent errorType={errorType} errorInfo={errorInfo} />
      </CalloutContent>
      {showRetryButton && (
        <Button
          onClick={handleRetry}
          variant="ghost"
          iconOnly
          loading={isRetrying}
          className="size-6 shrink-0"
          title="Retry"
          aria-label="Retry"
        >
          <RotateCcw />
        </Button>
      )}
    </Callout>
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
    <div className="flex flex-col gap-2">
      <p className="text-xs font-medium flex items-center gap-1 text-error">
        {header}
      </p>
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
    <div className="flex flex-col gap-2">
      <p className="text-xs font-medium flex items-center gap-1 text-error">
        {header}
      </p>
      {errorStr &&
        (renderAnsi ? (
          <ExceptionFrames
            className="whitespace-pre-wrap break-words p-3 leading-relaxed"
            dangerouslySetInnerHTML={{ __html: ansiToHtml(errorStr, theme) }}
          />
        ) : (
          <ExceptionFrames className="whitespace-pre-wrap break-words p-3 leading-relaxed">
            {errorStr}
          </ExceptionFrames>
        ))}
    </div>
  );
}

function ErrorDetails({ errorInfo }: { errorInfo: string }) {
  return (
    <Exception className="mt-2">
      <ExceptionHeader className="min-h-0 px-3 py-1.5">
        <ExceptionTrigger>Details</ExceptionTrigger>
      </ExceptionHeader>
      <ExceptionContent keepMounted>
        <ExceptionFrames className="whitespace-pre-wrap break-words p-3 leading-relaxed">
          {errorInfo}
        </ExceptionFrames>
      </ExceptionContent>
    </Exception>
  );
}

function ChatContent({
  errorType,
  errorInfo,
}: {
  errorType: Thread["errorMessage"];
  errorInfo: Thread["errorMessageInfo"];
}) {
  const errorTypeStrict = normalizeChatErrorType(errorType);
  if (errorTypeStrict === null) {
    return <UnknownChatError errorType={errorType} errorInfo={errorInfo} />;
  }
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
              {errorInfo ? <ErrorDetails errorInfo={errorInfo} /> : null}
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
              .{errorInfo ? <ErrorDetails errorInfo={errorInfo} /> : null}
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
              {errorInfo ? <ErrorDetails errorInfo={errorInfo} /> : null}
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
      // Every ThreadErrorType above must have a case; adding a union variant
      // without a case here is now a compile error.
      const _exhaustiveCheck: never = errorTypeStrict;
      return _exhaustiveCheck;
    }
  }
}

function UnknownChatError({
  errorType,
  errorInfo,
}: {
  errorType: Thread["errorMessage"];
  errorInfo: Thread["errorMessageInfo"];
}) {
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
