import { ThreadErrorType } from "@terragon/shared";
import { RuntimeFailureCategory } from "@terragon/shared/runtime/failure";

export class ThreadError extends Error {
  type: ThreadErrorType;
  info: string;
  originalError: Error | null;
  failureCategory: RuntimeFailureCategory | null;

  constructor(
    type: ThreadErrorType,
    info: string,
    originalError: Error | null,
    failureCategory?: RuntimeFailureCategory | null,
  ) {
    super(`Thread error: ${type}${info ? `: ${info}` : ""}`, {
      cause: originalError,
    });
    this.type = type;
    this.info = info;
    this.originalError = originalError;
    this.failureCategory = failureCategory ?? null;
    this.name = "ThreadError";
  }
}

export function wrapError(
  type: ThreadErrorType,
  error: unknown,
  failureCategory?: RuntimeFailureCategory,
): ThreadError {
  if (error instanceof ThreadError) {
    if (failureCategory && !error.failureCategory) {
      error.failureCategory = failureCategory;
    }
    return error;
  }
  if (error instanceof Error) {
    return new ThreadError(type, error.message, error, failureCategory);
  }
  return new ThreadError(type, String(error), null, failureCategory);
}

export const allThreadErrors: Record<ThreadErrorType, boolean> = {
  "request-timeout": true,
  "no-user-message": true,
  "unknown-error": true,
  "sandbox-not-found": true,
  "sandbox-creation-failed": true,
  "sandbox-resume-failed": true,
  "missing-gemini-credentials": true,
  "missing-amp-credentials": true,
  "chatgpt-sub-required": true,
  "invalid-codex-credentials": true,
  "invalid-claude-credentials": true,
  "agent-not-responding": true,
  "agent-generic-error": true,
  "git-checkpoint-diff-failed": true,
  "git-checkpoint-push-failed": true,
  "setup-script-failed": true,
  "prompt-too-long": true,
  "queue-limit-exceeded": true,
};
