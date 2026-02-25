/**
 * Linear OAuth token refresh utility.
 *
 * Implements DB-level optimistic CAS to handle concurrent refreshes across
 * multiple Vercel serverless instances (in-memory mutex is insufficient).
 *
 * Linear access tokens expire after 24 hours. We refresh proactively when
 * within 5 minutes of expiry.
 *
 * If the refresh token is null and the access token is expired, we
 * deactivate the installation and surface a "reinstall required" state.
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

export type LinearTokenRefreshResult =
  | { status: "ok"; accessToken: string }
  | { status: "reinstall_required" }
  | { status: "not_found" }
  | { status: "not_expired" };

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

  if (!installation || !installation.isActive) {
    return { status: "not_found" };
  }

  const masterKey = env.ENCRYPTION_MASTER_KEY;
  const currentAccessToken = decryptValue(
    installation.accessTokenEncrypted,
    masterKey,
  );

  // Check if token needs refresh
  const expiresAt = installation.tokenExpiresAt;
  const needsRefresh =
    expiresAt !== null &&
    expiresAt.getTime() - now().getTime() < REFRESH_BUFFER_MS;

  if (!needsRefresh) {
    return { status: "ok", accessToken: currentAccessToken };
  }

  // Token is expired or about to expire — attempt refresh
  const refreshTokenEncrypted = installation.refreshTokenEncrypted;
  if (!refreshTokenEncrypted) {
    // No refresh token available — deactivate and signal reinstall needed
    await deactivateLinearInstallation({ db, organizationId });
    return { status: "reinstall_required" };
  }

  const refreshToken = decryptValue(refreshTokenEncrypted, masterKey);

  let tokenResponse: {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    token_type?: string;
  };

  try {
    const response = await fetch(LINEAR_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.LINEAR_CLIENT_ID,
        client_secret: env.LINEAR_CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      // invalid_grant means the refresh token is no longer valid
      if (body.includes("invalid_grant") || response.status === 400) {
        await deactivateLinearInstallation({ db, organizationId });
        return { status: "reinstall_required" };
      }
      throw new Error(
        `Linear token refresh failed: ${response.status} ${body}`,
      );
    }

    tokenResponse = await response.json();
  } catch (err) {
    // Re-throw non-invalid_grant errors; caller handles retry logic
    throw err;
  }

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
    const freshAccessToken = decryptValue(
      refreshed.accessTokenEncrypted,
      masterKey,
    );
    return { status: "ok", accessToken: freshAccessToken };
  }

  return { status: "ok", accessToken: newAccessToken };
}
