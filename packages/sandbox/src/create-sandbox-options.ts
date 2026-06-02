import type { CreateSandboxOptions } from "./types";

function normalizeOptionalSandboxString(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const normalized = String(value).trim();
  return normalized || undefined;
}

export function normalizeCreateSandboxOptions(
  options: CreateSandboxOptions,
): CreateSandboxOptions {
  const snapshotTemplateId = normalizeOptionalSandboxString(
    options.snapshotTemplateId,
  );
  if (snapshotTemplateId === options.snapshotTemplateId) {
    return options;
  }
  return { ...options, snapshotTemplateId };
}
