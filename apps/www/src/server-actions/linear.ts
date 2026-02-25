"use server";

import { env } from "@terragon/env/apps-www";
import { nonLocalhostPublicAppUrl } from "@/lib/server-utils";
import { userOnlyAction } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { UserFacingError } from "@/lib/server-actions";
import {
  getLinearAccountForLinearUserId,
  upsertLinearAccount,
  disconnectLinearAccountAndSettings,
  upsertLinearSettings,
  deactivateLinearInstallation,
} from "@terragon/shared/model/linear";
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
    // Encrypted CSRF state with userId, timestamp, and type
    const state = encryptValue(
      JSON.stringify({
        userId,
        timestamp: Date.now(),
        type: "agent_install",
      }),
      env.ENCRYPTION_MASTER_KEY,
    );
    linearAuthUrl.searchParams.set("state", state);
    return linearAuthUrl.toString();
  },
  { defaultErrorMessage: "Failed to get Linear agent install URL" },
);

// v1 DESIGN DECISION: Manual account linking without OAuth/ownership proof.
// This is an accepted limitation documented in the epic spec. The
// linearIntegration feature flag gates access to trusted users only.
// The DB unique index on (linearUserId, organizationId) prevents duplicate
// claims. A challenge-based ownership verification flow is planned for v2.
export const connectLinearAccount = userOnlyAction(
  async function connectLinearAccount(
    userId: string,
    {
      organizationId,
      linearUserId,
      linearUserName,
      linearUserEmail,
    }: {
      organizationId: string;
      linearUserId: string;
      linearUserName: string;
      linearUserEmail: string;
    },
  ): Promise<void> {
    await assertLinearEnabled(userId);

    // Pre-check for friendly error message (non-atomic, see catch below)
    const existing = await getLinearAccountForLinearUserId({
      db,
      organizationId,
      linearUserId,
    });
    if (existing && existing.userId !== userId) {
      throw new UserFacingError(
        "This Linear user ID is already linked to another Terragon account",
      );
    }

    try {
      await upsertLinearAccount({
        db,
        userId,
        organizationId,
        account: {
          linearUserId,
          linearUserName,
          linearUserEmail,
        },
      });
    } catch (error: any) {
      // Handle race condition: concurrent claim slipping past pre-check
      if (error?.code === "23505") {
        throw new UserFacingError(
          "This Linear user ID is already linked to another Terragon account",
        );
      }
      throw error;
    }
  },
  { defaultErrorMessage: "Failed to connect Linear account" },
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
// given organization. This removes the agent from the workspace.
// TODO: restrict to admin role in a future iteration.
// Requires UI confirmation before calling (see task 5).
export const uninstallLinearWorkspace = userOnlyAction(
  async function uninstallLinearWorkspace(
    userId: string,
    { organizationId }: { organizationId: string },
  ): Promise<void> {
    await assertLinearEnabled(userId);
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
