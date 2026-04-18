import { devDefaultAppUrl, devDefaultBroadcastPort } from "./common";

function getVercelPublicHost(): string | null {
  return (
    process.env.NEXT_PUBLIC_VERCEL_BRANCH_URL ??
    process.env.VERCEL_BRANCH_URL ??
    process.env.VERCEL_URL ??
    null
  );
}

export function publicBroadcastUrl() {
  if (process.env.NODE_ENV === "development") {
    return (
      process.env.NEXT_PUBLIC_BROADCAST_URL ??
      `http://localhost:${devDefaultBroadcastPort}`
    );
  }
  if (!process.env.NEXT_PUBLIC_BROADCAST_URL) {
    throw new Error("NEXT_PUBLIC_BROADCAST_URL is not set");
  }
  return process.env.NEXT_PUBLIC_BROADCAST_URL;
}

export function publicAppUrl() {
  const vercelEnv =
    process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.VERCEL_ENV;
  const vercelPublicHost = getVercelPublicHost();

  if (vercelEnv === "preview" && vercelPublicHost) {
    return `https://${vercelPublicHost}`;
  }
  if (process.env.NODE_ENV === "development") {
    if (process.env.NEXT_PUBLIC_APP_URL) {
      return process.env.NEXT_PUBLIC_APP_URL;
    }
    // For local development, use the origin of the current window if available.
    // This is useful for local development when you're testing on your phone.
    if (typeof window !== "undefined" && window.location.origin) {
      return window.location.origin;
    }
    return devDefaultAppUrl;
  }
  if (!process.env.NEXT_PUBLIC_APP_URL) {
    if (vercelPublicHost) {
      return `https://${vercelPublicHost}`;
    }
    throw new Error("NEXT_PUBLIC_APP_URL is not set");
  }
  return process.env.NEXT_PUBLIC_APP_URL;
}

export function publicBroadcastHost() {
  if (process.env.NODE_ENV === "development") {
    if (process.env.NEXT_PUBLIC_BROADCAST_HOST) {
      return process.env.NEXT_PUBLIC_BROADCAST_HOST;
    }
    if (typeof window !== "undefined" && window.location.hostname) {
      return `${window.location.hostname}:${devDefaultBroadcastPort}`;
    }
    return `localhost:${devDefaultBroadcastPort}`;
  }
  if (!process.env.NEXT_PUBLIC_BROADCAST_HOST) {
    throw new Error("NEXT_PUBLIC_BROADCAST_HOST is not set");
  }
  return process.env.NEXT_PUBLIC_BROADCAST_HOST;
}

export function publicDocsUrl() {
  if (process.env.NODE_ENV === "development") {
    return process.env.NEXT_PUBLIC_DOCS_URL ?? "http://localhost:3001";
  }
  return process.env.NEXT_PUBLIC_DOCS_URL ?? "https://docs.terragonlabs.com";
}
