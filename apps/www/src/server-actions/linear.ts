"use server";

import { env } from "@terragon/env/apps-www";
import { nonLocalhostPublicAppUrl } from "@/lib/server-utils";
import { userOnlyAction } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { UserFacingError } from "@/lib/server-actions";
import {
  getLinearInstallationForOrg,
  disconnectLinearAccountAndSettings,
  upsertLinearSettings,
  deactivateLinearInstallation,
} from "@terragon/shared/model/linear";
import { getUserOrNull } from "@/lib/auth-server";
import { getFeatureFlagForUser } from "@terragon/shared/model/feature-flags";
import { LinearSettingsInsert } from "@terragon/shared/db/types";
import { encryptValue } from "@terragon/utils/encryption";

async function assertLinearEnabled(userId: string) {
  const enabled = await getFeatureFlagForUser({
    db,
    userId,
    flagName: "linearIntegration",
  });
  if (!enabled) {
    throw new UserFacingError("Linear integration is not enabled");
  }
}

// State payload types for the shared /api/auth/linear/callback route.
// "agent_install" is the workspace-level app-actor OAuth (installs the Linear
// Agent). "account_link" is the per-user OAuth flow that identifies which
// Linear user a Terragon user owns — we discard the returned token immediately
// after calling `viewer`; all ongoing API calls use the workspace install's
// app token via refreshLinearTokenIfNeeded.
export type LinearOAuthStateType = "agent_install" | "account_link";

/**
 * Builds an encrypted CSRF state payload for Linear OAuth flows. Both the
 * agent install and the personal account link flows reuse the same callback
 * route (/api/auth/linear/callback), so the state discriminates between them.
 */
function buildLinearOAuthState({
  userId,
  type,
}: {
  userId: string;
  type: LinearOAuthStateType;
}): string {
  return encryptValue(
    JSON.stringify({
      userId,
      timestamp: Date.now(),
      type,
    }),
    env.ENCRYPTION_MASTER_KEY,
  );
}

// Generates the OAuth 2.0 authorization URL for installing the Linear Agent.
// Uses actor=app so the agent is a first-class workspace participant
// (mentionable, assignable). Mirrors getSlackAppInstallUrl pattern with
// encrypted CSRF state.
export const getLinearAgentInstallUrl = userOnlyAction(
  async function getLinearAgentInstallUrl(userId: string): Promise<string> {
    await assertLinearEnabled(userId);
    if (!env.LINEAR_CLIENT_ID || !env.LINEAR_CLIENT_SECRET) {
      throw new Error("Linear OAuth is not configured");
    }
    const redirectUri = `${nonLocalhostPublicAppUrl()}/api/auth/linear/callback`;
    const linearAuthUrl = new URL("https://linear.app/oauth/authorize");
    linearAuthUrl.searchParams.set("client_id", env.LINEAR_CLIENT_ID);
    linearAuthUrl.searchParams.set("redirect_uri", redirectUri);
    linearAuthUrl.searchParams.set("response_type", "code");
    // Comma-separated scopes (Linear requires comma, not space)
    linearAuthUrl.searchParams.set(
      "scope",
      "read,write,app:assignable,app:mentionable",
    );
    // actor=app makes the OAuth token act as the app, not a user
    linearAuthUrl.searchParams.set("actor", "app");
    linearAuthUrl.searchParams.set(
      "state",
      buildLinearOAuthState({ userId, type: "agent_install" }),
    );
    return linearAuthUrl.toString();
  },
  { defaultErrorMessage: "Failed to get Linear agent install URL" },
);

// Generates the OAuth 2.0 authorization URL for linking a personal Linear
// account to a Terragon user. Uses the default actor=user mode so the returned
// token represents the authenticating human, enabling a `viewer` query that
// returns the user's Linear id/name/email/organization. Linear's docs
// explicitly recommend this pattern for "per-user personal account linking"
// (see https://linear.app/developers/oauth-actor-authorization). Only the
// `read` scope is needed — we never mutate and never persist the returned
// token, we just call viewer once in the callback and discard it.
export const getLinearAccountConnectUrl = userOnlyAction(
  async function getLinearAccountConnectUrl(userId: string): Promise<string> {
    await assertLinearEnabled(userId);
    if (!env.LINEAR_CLIENT_ID || !env.LINEAR_CLIENT_SECRET) {
      throw new Error("Linear OAuth is not configured");
    }
    const redirectUri = `${nonLocalhostPublicAppUrl()}/api/auth/linear/callback`;
    const linearAuthUrl = new URL("https://linear.app/oauth/authorize");
    linearAuthUrl.searchParams.set("client_id", env.LINEAR_CLIENT_ID);
    linearAuthUrl.searchParams.set("redirect_uri", redirectUri);
    linearAuthUrl.searchParams.set("response_type", "code");
    // Only need read scope — we call viewer() once and throw away the token.
    // Intentionally NO actor=app: we want a user-scoped token here so that
    // `viewer` returns the authenticating human, not the app itself.
    linearAuthUrl.searchParams.set("scope", "read");
    linearAuthUrl.searchParams.set(
      "state",
      buildLinearOAuthState({ userId, type: "account_link" }),
    );
    return linearAuthUrl.toString();
  },
  { defaultErrorMessage: "Failed to get Linear account connect URL" },
);

// Per-user disconnect: removes linearAccount + linearSettings for the current
// user only. Does NOT touch linearInstallation (workspace-level OAuth tokens).
// To remove the workspace agent installation, use uninstallLinearWorkspace.
export const disconnectLinearAccount = userOnlyAction(
  async function disconnectLinearAccount(
    userId: string,
    { organizationId }: { organizationId: string },
  ): Promise<void> {
    await assertLinearEnabled(userId);
    await disconnectLinearAccountAndSettings({ db, userId, organizationId });
  },
  { defaultErrorMessage: "Failed to disconnect Linear account" },
);

// Workspace uninstall: deactivates the linearInstallation record for the
// given organization. This removes the agent from the workspace for all users.
// Access guard: only the original installer or an admin may uninstall.
// This prevents arbitrary feature-flag users from causing workspace-wide DoS.
// TODO v2: gate fully on admin role via adminOnlyAction.
export const uninstallLinearWorkspace = userOnlyAction(
  async function uninstallLinearWorkspace(
    userId: string,
    { organizationId }: { organizationId: string },
  ): Promise<void> {
    await assertLinearEnabled(userId);

    // Enforce installer-or-admin guard
    const [user, installation] = await Promise.all([
      getUserOrNull(),
      getLinearInstallationForOrg({ db, organizationId }),
    ]);
    if (!installation) {
      throw new UserFacingError("No active Linear installation found");
    }
    const isAdmin = user?.role === "admin";
    const isInstaller = installation.installerUserId === userId;
    if (!isAdmin && !isInstaller) {
      throw new UserFacingError(
        "Only the workspace installer or an admin can uninstall the Linear agent",
      );
    }

    await deactivateLinearInstallation({ db, organizationId });
  },
  { defaultErrorMessage: "Failed to uninstall Linear workspace" },
);

export const updateLinearSettings = userOnlyAction(
  async function updateLinearSettings(
    userId: string,
    {
      organizationId,
      settings,
    }: {
      organizationId: string;
      settings: Omit<LinearSettingsInsert, "userId" | "organizationId">;
    },
  ): Promise<void> {
    await assertLinearEnabled(userId);
    await upsertLinearSettings({ db, userId, organizationId, settings });
  },
  { defaultErrorMessage: "Failed to update Linear settings" },
);
