import { NextRequest } from "next/server";
import { getUserIdOrNull } from "@/lib/auth-server";
import { decryptValue, encryptValue } from "@terragon/utils/encryption";
import { env } from "@terragon/env/apps-www";
import { redirect, notFound } from "next/navigation";
import { db } from "@/lib/db";
import { upsertLinearInstallation } from "@terragon/shared/model/linear";
import { nonLocalhostPublicAppUrl } from "@/lib/server-utils";
import { LinearClient } from "@linear/sdk";

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
  try {
    const decryptedState = decryptValue(state, env.ENCRYPTION_MASTER_KEY);
    const parsed = JSON.parse(decryptedState);
    stateUserId = parsed.userId;
    timestamp = parsed.timestamp;
    // Validate shape: prevent cross-flow state reuse and bypass via missing
    // or non-finite timestamp (NaN < cutoff is false — expiry skipped)
    if (
      typeof stateUserId !== "string" ||
      !Number.isFinite(timestamp) ||
      parsed.type !== "agent_install"
    ) {
      redirect(
        "/settings/integrations?integration=linear&status=error&code=invalid_state",
      );
      return;
    }
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

  // 7. tokenExpiresAt computed from expires_in (seconds)
  const tokenExpiresAt = new Date(Date.now() + tokenData.expires_in * 1000);

  // 8. Fetch org info via LinearClient with the new access token
  let organizationId: string;
  let organizationName: string;

  try {
    const linearClient = new LinearClient({
      accessToken: tokenData.access_token,
    });
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

  // 9. Upsert linearInstallation with encrypted tokens
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

  // 10. Redirect to success
  redirect(
    "/settings/integrations?integration=linear&status=success&code=agent_installed",
  );
}
