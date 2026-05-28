export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserFacingError";
  }
}

export type ServerActionResult<TData = unknown> =
  | { success: true; data: TData; errorMessage?: undefined }
  | { success: false; data?: undefined; errorMessage: string };

export function serverActionSuccess<TData>(
  data: TData,
): ServerActionResult<TData> {
  return { success: true, data };
}

export function wrapServerActionError({
  error,
  defaultMessage,
}: {
  error: unknown;
  defaultMessage: string;
}): ServerActionResult<any> {
  const errorMessage =
    error instanceof UserFacingError ? error.message : defaultMessage;
  return { success: false, errorMessage };
}

export type ServerActionOptions = {
  defaultErrorMessage: string;
};

// NOTE: Use via auth-server.ts (userOnly or adminOnly).
export function wrapServerActionInternal<TArgs extends Array<any>, TData>(
  callback: (...args: TArgs) => Promise<TData>,
  options: ServerActionOptions,
): (...args: TArgs) => Promise<ServerActionResult<TData>> {
  return async (...args: TArgs) => {
    try {
      const data = await callback(...args);
      return serverActionSuccess(data);
    } catch (error) {
      console.error("Error in server action", error);
      return wrapServerActionError({
        error,
        defaultMessage: options.defaultErrorMessage,
      });
    }
  };
}

export function unwrapResult<TData>(result: ServerActionResult<TData>): TData {
  if (!result.success) {
    throw new UserFacingError(result.errorMessage);
  }
  return result.data;
}

export function unwrapError(error: unknown) {
  return error instanceof UserFacingError
    ? error.message
    : "An unexpected error occurred";
}

/**
 * Execute a getter and throw a UserFacingError if the result is nullish.
 * This is the standard guard used across server-actions for "not found" checks.
 */
export async function requireResult<T>(
  getter: () => Promise<T | null | undefined>,
  errorMessage: string,
): Promise<NonNullable<T>> {
  const result = await getter();
  if (!result) {
    throw new UserFacingError(errorMessage);
  }
  return result as NonNullable<T>;
}
