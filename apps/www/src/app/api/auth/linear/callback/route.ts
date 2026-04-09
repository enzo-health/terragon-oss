import { NextRequest } from "next/server";
import { getUserIdOrNull } from "@/lib/auth-server";
import { decryptValue, encryptValue } from "@terragon/utils/encryption";
import { env } from "@terragon/env/apps-www";
import { redirect, notFound } from "next/navigation";
import { db } from "@/lib/db";
import {
  upsertLinearAccount,
  upsertLinearInstallation,
} from "@terragon/shared/model/linear";
import { nonLocalhostPublicAppUrl } from "@/lib/server-utils";
import { LinearClient } from "@linear/sdk";
import type { LinearOAuthStateType } from "@/server-actions/linear";

/** PostgreSQL SQLSTATE for unique constraint violation. */
const PG_UNIQUE_VIOLATION = "23505";

export async function GET(request: NextRequest) {
  // 1. Verify userId from session — redirect to notFound if missing
  const userId = await getUserIdOrNull();
  if (!userId) {
    notFound();
    return;
  }

  const searchParams = request.nextUrl.searchParams;
  const error = searchParams.get("error");
  const code = searchParams.get("code");
  const state = searchParams.get("state");

  // 2. Handle error param FIRST — access_denied may omit code entirely,
  //    causing a crash if we check code/state first (fixes Slack's bug pattern)
  if (error) {
    console.error("Linear OAuth error:", error);
    if (error === "access_denied") {
      redirect(
        "/settings/integrations?integration=linear&status=error&code=auth_cancelled",
      );
      return;
    }
    redirect(
      "/settings/integrations?integration=linear&status=error&code=auth_error",
    );
    return;
  }

  // 3. Validate state exists, then wrap decrypt + JSON.parse in try/catch
  //    Tampered/invalid state → redirect to invalid_state (not a 500)
  if (!state) {
    redirect(
      "/settings/integrations?integration=linear&status=error&code=invalid_state",
    );
    return;
  }

  let stateUserId: string;
  let timestamp: number;
  let flowType: LinearOAuthStateType;
  try {
    const decryptedState = decryptValue(state, env.ENCRYPTION_MASTER_KEY);
    const parsed = JSON.parse(decryptedState);
    stateUserId = parsed.userId;
    timestamp = parsed.timestamp;
    // Validate shape: prevent cross-flow state reuse and bypass via missing
    // or non-finite timestamp (NaN < cutoff is false — expiry skipped).
    // Accept either the workspace agent install flow or the per-user account
    // link flow — both are dispatched through this callback with a state
    // discriminator (see apps/www/src/server-actions/linear.ts).
    if (
      typeof stateUserId !== "string" ||
      !Number.isFinite(timestamp) ||
      (parsed.type !== "agent_install" && parsed.type !== "account_link")
    ) {
      redirect(
        "/settings/integrations?integration=linear&status=error&code=invalid_state",
      );
      return;
    }
    flowType = parsed.type;
  } catch {
    redirect(
      "/settings/integrations?integration=linear&status=error&code=invalid_state",
    );
    return;
  }

  // 4. Validate state contents: userId match and <24h expiry
  if (stateUserId !== userId) {
    redirect(
      "/settings/integrations?integration=linear&status=error&code=invalid_state",
    );
    return;
  }
  if (timestamp < Date.now() - 1000 * 60 * 60 * 24) {
    redirect(
      "/settings/integrations?integration=linear&status=error&code=invalid_state",
    );
    return;
  }

  // 5. Validate code exists
  if (!code) {
    redirect(
      "/settings/integrations?integration=linear&status=error&code=invalid_params",
    );
    return;
  }

  // 6. Exchange code for tokens
  const redirectUri = `${nonLocalhostPublicAppUrl()}/api/auth/linear/callback`;
  const params = new URLSearchParams();
  params.append("client_id", env.LINEAR_CLIENT_ID!);
  params.append("client_secret", env.LINEAR_CLIENT_SECRET!);
  params.append("code", code);
  params.append("redirect_uri", redirectUri);
  params.append("grant_type", "authorization_code");

  let tokenData: {
    access_token: string;
    token_type: string;
    expires_in: number;
    scope: string;
    refresh_token?: string;
  };

  // Separate fetch from redirect to avoid calling redirect() inside try/catch
  // (Next.js redirect() throws NEXT_REDIRECT which would be swallowed by catch)
  let tokenResponse: Response;
  try {
    tokenResponse = await fetch("https://api.linear.app/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    });
  } catch (err) {
    console.error("Linear token exchange network error:", err);
    redirect(
      "/settings/integrations?integration=linear&status=error&code=auth_error",
    );
    return;
  }

  if (!tokenResponse.ok) {
    const errorBody = await tokenResponse.text();
    console.error("Linear token exchange failed:", errorBody);
    redirect(
      "/settings/integrations?integration=linear&status=error&code=auth_error",
    );
    return;
  }

  tokenData = await tokenResponse.json();

  // 7. Defense-in-depth: verify the token's granted scope matches the scope
  //    our flow requested. This blocks a cross-flow state substitution where
  //    an attacker swaps an `account_link` state into an `agent_install` auth
  //    URL (or vice versa) — the encrypted state's userId check already
  //    prevents cross-user confusion, but scope-matching closes the
  //    self-race case where the same user has both flows in flight.
  //
  //    - account_link requests `read` only → granted scope must be exactly
  //      "read" (Linear returns comma-separated scopes).
  //    - agent_install requests `read,write,app:assignable,app:mentionable`
  //      → granted scope must include both app:* scopes (the distinctive
  //      markers of the agent flow).
  // Defensive: tokenResponse.json() returns `any`, so tokenData.scope could
  // be anything at runtime even though the type annotation says `string`.
  // Reject anything that isn't a non-empty string before attempting to parse.
  if (typeof tokenData.scope !== "string" || tokenData.scope.length === 0) {
    console.error(
      "Linear token response missing or malformed scope:",
      tokenData.scope,
    );
    redirect(
      "/settings/integrations?integration=linear&status=error&code=invalid_state",
    );
    return;
  }

  const grantedScope: string = tokenData.scope;
  const grantedScopes = grantedScope
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (flowType === "account_link") {
    const hasOnlyRead =
      grantedScopes.length > 0 && grantedScopes.every((s) => s === "read");
    if (!hasOnlyRead) {
      console.error(
        "Linear account_link flow received unexpected scope:",
        grantedScope,
      );
      redirect(
        "/settings/integrations?integration=linear&status=error&code=invalid_state",
      );
      return;
    }
  } else {
    // agent_install
    const hasAppScopes =
      grantedScopes.includes("app:assignable") &&
      grantedScopes.includes("app:mentionable");
    if (!hasAppScopes) {
      console.error(
        "Linear agent_install flow received unexpected scope:",
        grantedScope,
      );
      redirect(
        "/settings/integrations?integration=linear&status=error&code=invalid_state",
      );
      return;
    }
  }

  // 8. Branch on flow type.
  //
  //    - agent_install: token is workspace-app-scoped (actor=app). Fetch the
  //      organization, encrypt and persist the tokens in linearInstallation.
  //    - account_link: token is user-scoped (default actor=user). Call viewer
  //      once to get the authenticating user's identity, upsert it into
  //      linearAccount, and DISCARD the token — all ongoing API calls use
  //      the workspace install's app token via refreshLinearTokenIfNeeded.
  const linearClient = new LinearClient({
    accessToken: tokenData.access_token,
  });

  if (flowType === "account_link") {
    // 8a. Per-user identity link — Linear's docs explicitly recommend this
    //     pattern (see https://linear.app/developers/oauth-actor-authorization).
    let linearUserId: string;
    let linearUserName: string;
    let linearUserEmail: string;
    let organizationId: string;
    try {
      const viewer = await linearClient.viewer;
      const viewerOrg = await viewer.organization;
      linearUserId = viewer.id;
      linearUserName = viewer.name;
      linearUserEmail = viewer.email;
      organizationId = viewerOrg.id;
    } catch (err) {
      console.error("Linear viewer fetch error:", err);
      redirect(
        "/settings/integrations?integration=linear&status=error&code=auth_error",
      );
      return;
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
    } catch (err: unknown) {
      // Unique index (linearUserId, organizationId) — another Terragon user
      // has already claimed this Linear identity in this workspace.
      const isUniqueViolation =
        typeof err === "object" &&
        err !== null &&
        "code" in err &&
        (err as { code: unknown }).code === PG_UNIQUE_VIOLATION;
      if (isUniqueViolation) {
        redirect(
          "/settings/integrations?integration=linear&status=error&code=already_linked",
        );
        return;
      }
      throw err;
    }

    redirect(
      "/settings/integrations?integration=linear&status=success&code=account_linked",
    );
    return;
  }

  // 8b. Workspace agent install — fetch org info and persist tokens.
  const tokenExpiresAt = new Date(Date.now() + tokenData.expires_in * 1000);

  let organizationId: string;
  let organizationName: string;
  try {
    const org = await linearClient.organization;
    organizationId = org.id;
    organizationName = org.name;
  } catch (err) {
    console.error("Linear org fetch error:", err);
    redirect(
      "/settings/integrations?integration=linear&status=error&code=auth_error",
    );
    return;
  }

  await upsertLinearInstallation({
    db,
    installation: {
      organizationId,
      organizationName,
      accessTokenEncrypted: encryptValue(
        tokenData.access_token,
        env.ENCRYPTION_MASTER_KEY,
      ),
      refreshTokenEncrypted: tokenData.refresh_token
        ? encryptValue(tokenData.refresh_token, env.ENCRYPTION_MASTER_KEY)
        : null,
      tokenExpiresAt,
      scope: tokenData.scope,
      installerUserId: userId,
      isActive: true,
    },
  });

  redirect(
    "/settings/integrations?integration=linear&status=success&code=agent_installed",
  );
}
