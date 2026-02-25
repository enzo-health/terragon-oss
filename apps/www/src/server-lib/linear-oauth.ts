/**
 * Linear OAuth token refresh utility.
 *
 * Implements DB-level optimistic CAS to handle concurrent refreshes across
 * multiple Vercel serverless instances (in-memory mutex is insufficient).
 *
 * Linear access tokens expire after 24 hours. We refresh proactively when
 * within 5 minutes of expiry, or when tokenExpiresAt is null (unknown expiry).
 *
 * If the refresh token is null and the token needs refresh, we deactivate
 * the installation and surface a "reinstall required" state.
 */

import { env } from "@terragon/env/apps-www";
import type { DB } from "@terragon/shared/db";
import {
  deactivateLinearInstallation,
  getLinearInstallationForOrg,
  updateLinearInstallationTokens,
} from "@terragon/shared/model/linear";
import { decryptValue, encryptValue } from "@terragon/utils/encryption";

const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";

/** Refresh proactively if token expires within this many ms */
const REFRESH_BUFFER_MS = 5 * 60 * 1000; // 5 minutes

/** Timeout for Linear token refresh HTTP call */
const REFRESH_TIMEOUT_MS = 8_000; // 8s — safe within 10s webhook SLA

export type LinearTokenRefreshResult =
  | { status: "ok"; accessToken: string }
  | { status: "reinstall_required" }
  | { status: "not_found" };

/**
 * Helper: re-read the installation and return the current token (or reinstall_required).
 * Used after a CAS-guarded deactivation no-op, indicating a concurrent reinstall.
 */
async function readCurrentToken({
  db,
  organizationId,
  masterKey,
}: {
  db: DB;
  organizationId: string;
  masterKey: string;
}): Promise<LinearTokenRefreshResult> {
  const current = await getLinearInstallationForOrg({ db, organizationId });
  if (!current || !current.isActive) {
    return { status: "reinstall_required" };
  }
  return {
    status: "ok",
    accessToken: decryptValue(current.accessTokenEncrypted, masterKey),
  };
}

/**
 * Ensures the Linear installation's access token is valid, refreshing it if
 * needed. Uses DB-level optimistic CAS so concurrent calls are safe.
 *
 * @param organizationId - Linear organization ID
 * @param db - Database connection
 * @param opts.now - Injectable clock for testing (defaults to `() => new Date()`)
 * @returns The current access token, or a status indicating reinstall is needed
 */
export async function refreshLinearTokenIfNeeded(
  organizationId: string,
  db: DB,
  opts?: { now?: () => Date },
): Promise<LinearTokenRefreshResult> {
  const now = opts?.now ?? (() => new Date());

  const installation = await getLinearInstallationForOrg({
    db,
    organizationId,
  });

  if (!installation) {
    return { status: "not_found" };
  }

  if (!installation.isActive) {
    // Row exists but was previously deactivated — reinstall required
    return { status: "reinstall_required" };
  }

  const masterKey = env.ENCRYPTION_MASTER_KEY;
  const currentAccessToken = decryptValue(
    installation.accessTokenEncrypted,
    masterKey,
  );

  // Check if token needs refresh:
  // - tokenExpiresAt is null → expiry unknown, treat as needing refresh
  // - token expires within REFRESH_BUFFER_MS → proactive refresh
  const expiresAt = installation.tokenExpiresAt;
  const needsRefresh =
    expiresAt === null ||
    expiresAt.getTime() - now().getTime() < REFRESH_BUFFER_MS;

  if (!needsRefresh) {
    return { status: "ok", accessToken: currentAccessToken };
  }

  // Token is expired, about to expire, or expiry unknown — attempt refresh
  const refreshTokenEncrypted = installation.refreshTokenEncrypted;
  if (!refreshTokenEncrypted) {
    // No refresh token — CAS-guarded deactivation so concurrent reinstall wins
    const { deactivated } = await deactivateLinearInstallation({
      db,
      organizationId,
      ifAccessTokenEncrypted: installation.accessTokenEncrypted,
    });
    if (!deactivated) {
      // CAS guard prevented deactivation — a concurrent reinstall succeeded.
      // Re-read and return the fresh token.
      return readCurrentToken({ db, organizationId, masterKey });
    }
    return { status: "reinstall_required" };
  }

  const refreshToken = decryptValue(refreshTokenEncrypted, masterKey);

  let tokenResponse: {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
  };

  const response = await fetch(LINEAR_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.LINEAR_CLIENT_ID,
      client_secret: env.LINEAR_CLIENT_SECRET,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
    signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
  });

  if (!response.ok) {
    const bodyText = await response.text();

    // Parse the OAuth error code from JSON body if present
    let oauthError: string | null = null;
    try {
      const parsed = JSON.parse(bodyText) as { error?: string };
      oauthError = parsed.error ?? null;
    } catch {
      // Body is not JSON — check plain text
      if (bodyText.includes("invalid_grant")) {
        oauthError = "invalid_grant";
      }
    }

    if (oauthError === "invalid_grant") {
      // Refresh token is revoked/expired. Before deactivating, re-read to
      // check if another concurrent refresh already succeeded (token rotation).
      const latest = await getLinearInstallationForOrg({ db, organizationId });
      if (
        latest &&
        latest.isActive &&
        latest.accessTokenEncrypted !== installation.accessTokenEncrypted
      ) {
        // Another instance refreshed successfully — use their token
        return {
          status: "ok",
          accessToken: decryptValue(latest.accessTokenEncrypted, masterKey),
        };
      }
      // Truly invalid — CAS-guarded deactivation so concurrent reinstall wins
      const { deactivated } = await deactivateLinearInstallation({
        db,
        organizationId,
        ifAccessTokenEncrypted: installation.accessTokenEncrypted,
      });
      if (!deactivated) {
        // Another instance reinstalled/refreshed concurrently — use their token
        return readCurrentToken({ db, organizationId, masterKey });
      }
      return { status: "reinstall_required" };
    }

    // For other errors (invalid_client, transient 5xx, etc.) — throw so
    // caller can retry. Do NOT deactivate; this may be a config issue.
    throw new Error(
      `Linear token refresh failed (${oauthError ?? response.status}): ${bodyText}`,
    );
  }

  tokenResponse = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
  };

  const newAccessToken = tokenResponse.access_token;
  const newRefreshToken = tokenResponse.refresh_token ?? null;
  const expiresInSeconds = tokenResponse.expires_in ?? 86400; // default 24h
  const newExpiresAt = new Date(now().getTime() + expiresInSeconds * 1000);

  const newAccessTokenEncrypted = encryptValue(newAccessToken, masterKey);
  const newRefreshTokenEncrypted = newRefreshToken
    ? encryptValue(newRefreshToken, masterKey)
    : undefined;

  // DB-level optimistic CAS: only write if tokenExpiresAt hasn't changed.
  // If 0 rows updated, another instance already refreshed — re-read token.
  const { updated } = await updateLinearInstallationTokens({
    db,
    organizationId,
    accessTokenEncrypted: newAccessTokenEncrypted,
    refreshTokenEncrypted: newRefreshTokenEncrypted,
    tokenExpiresAt: newExpiresAt,
    previousTokenExpiresAt: installation.tokenExpiresAt,
  });

  if (!updated) {
    // Another instance refreshed concurrently — re-read and use new token
    const refreshed = await getLinearInstallationForOrg({ db, organizationId });
    if (!refreshed || !refreshed.isActive) {
      return { status: "reinstall_required" };
    }
    return {
      status: "ok",
      accessToken: decryptValue(refreshed.accessTokenEncrypted, masterKey),
    };
  }

  return { status: "ok", accessToken: newAccessToken };
}
