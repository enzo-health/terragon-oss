export type SandboxStartupTimingAttrs = Record<
  string,
  boolean | number | string | null | undefined
>;

function formatTimingError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export async function timeSandboxStartupStage<T>(
  stage: string,
  attrs: SandboxStartupTimingAttrs,
  run: () => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  console.log("[sandbox-startup] stage.start", { stage, ...attrs });
  try {
    const result = await run();
    console.log("[sandbox-startup] stage.done", {
      stage,
      durationMs: Date.now() - startedAt,
      ...attrs,
    });
    return result;
  } catch (error) {
    console.warn("[sandbox-startup] stage.error", {
      stage,
      durationMs: Date.now() - startedAt,
      ...attrs,
      error: formatTimingError(error),
    });
    throw error;
  }
}
