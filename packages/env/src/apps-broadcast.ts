import { devDefaultAppUrl, devDefaultInternalSharedSecret } from "./common";

function getNonEmptyString(
  env: Record<string, unknown>,
  key: string,
): string | null {
  const raw = env[key];
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function getInternalSharedSecret(env: any) {
  const configured = getNonEmptyString(
    env as Record<string, unknown>,
    "INTERNAL_SHARED_SECRET",
  );
  if (env.NODE_ENV === "development") {
    return configured ?? devDefaultInternalSharedSecret;
  }
  if (!configured) {
    throw new Error("INTERNAL_SHARED_SECRET is not set");
  }
  return configured;
}

export function getPublicAppUrl(env: any) {
  const configured = getNonEmptyString(
    env as Record<string, unknown>,
    "BETTER_AUTH_URL",
  );
  if (env.NODE_ENV === "development") {
    return configured ?? devDefaultAppUrl;
  }
  if (!configured) {
    throw new Error("BETTER_AUTH_URL is not set");
  }
  return configured;
}
