import * as schema from "@terragon/shared/db/schema";
import { eq } from "drizzle-orm";
import { betterAuth } from "better-auth";
import {
  admin,
  apiKey,
  bearer,
  createAuthMiddleware,
  createAuthEndpoint,
  type BetterAuthPlugin,
  magicLink,
} from "better-auth/plugins";
import { setSessionCookie } from "better-auth/cookies";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { symmetricDecrypt } from "better-auth/crypto";
import { db } from "./db";
import { env } from "@terragon/env/apps-www";
import { getUserFlags } from "@terragon/shared/model/user-flags";
import { getPostHogServer } from "./posthog-server";
import { nonLocalhostPublicAppUrl } from "./server-utils";
import { publicAppUrl } from "@terragon/env/next-public";
import { maybeGrantSignupBonus } from "@/server-lib/credits";
import { LoopsClient } from "loops";
import { Resend } from "resend";
import { z } from "zod";

export const DEV_LOGIN_PROVIDER_ID = "dev-login";

const DEV_LOGIN_ACCOUNT_ID = "dev-login-account";
const DEV_LOGIN_DEFAULT_EMAIL = "dev@terragon.local";
const DEV_LOGIN_DEFAULT_NAME = "Terragon Dev";
const DEV_LOGIN_SUBSCRIPTION_ID = "dev-login-subscription";

type DevLoginUser = typeof schema.user.$inferSelect;
type DevLoginSandboxProvider =
  (typeof schema.userSettings.$inferInsert)["sandboxProvider"];

export function isDevLoginEnabled({
  enabled = env.ENABLE_DEV_LOGIN,
  nodeEnv = process.env.NODE_ENV,
}: {
  nodeEnv?: string;
  enabled?: boolean;
} = {}): boolean {
  return (
    enabled &&
    (nodeEnv === "development" ||
      process.env.TERRAGON_ALLOW_DEV_LOGIN_OUTSIDE_DEVELOPMENT === "true")
  );
}

export function resolveDevLoginReturnUrl(
  returnUrl: string | undefined,
): string {
  if (!returnUrl || !returnUrl.startsWith("/") || returnUrl.startsWith("//")) {
    return "/dashboard";
  }
  return returnUrl;
}

function resolveDevLoginGitHubToken(): string | undefined {
  if (!isDevLoginEnabled()) return undefined;
  return process.env.DEV_LOGIN_GITHUB_TOKEN || process.env.GITHUB_TOKEN;
}

function resolveDevLoginSandboxProvider(): DevLoginSandboxProvider | undefined {
  if (!isDevLoginEnabled()) return undefined;
  switch (process.env.DEV_LOGIN_SANDBOX_PROVIDER) {
    case "docker":
    case "e2b":
    case "daytona":
    case "mock":
    case "default":
      return process.env.DEV_LOGIN_SANDBOX_PROVIDER;
    default:
      return undefined;
  }
}

const initialAdminEmails = new Set(
  env.INITIAL_ADMIN_EMAILS.split(",")
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.length > 0),
);

async function ensureDevLoginUser(): Promise<DevLoginUser> {
  const now = new Date();
  const insertUserResult = await db
    .insert(schema.user)
    .values({
      id: "dev-login-user",
      name: DEV_LOGIN_DEFAULT_NAME,
      email: DEV_LOGIN_DEFAULT_EMAIL,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.user.email,
      set: {
        name: DEV_LOGIN_DEFAULT_NAME,
        emailVerified: true,
        updatedAt: now,
      },
    })
    .returning();
  const user = insertUserResult[0];
  if (!user) {
    throw new Error("Failed to create dev login user");
  }

  await db
    .insert(schema.account)
    .values({
      id: DEV_LOGIN_ACCOUNT_ID,
      accountId: DEV_LOGIN_DEFAULT_EMAIL,
      providerId: DEV_LOGIN_PROVIDER_ID,
      userId: user.id,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: schema.account.id,
      set: {
        accountId: DEV_LOGIN_DEFAULT_EMAIL,
        providerId: DEV_LOGIN_PROVIDER_ID,
        userId: user.id,
        updatedAt: now,
      },
    });

  const githubToken = resolveDevLoginGitHubToken();
  if (githubToken) {
    await db
      .insert(schema.account)
      .values({
        id: "dev-login-github-account",
        accountId: DEV_LOGIN_DEFAULT_EMAIL,
        providerId: "github",
        userId: user.id,
        accessToken: githubToken,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.account.id,
        set: {
          accessToken: githubToken,
          updatedAt: now,
        },
      });
  }

  const sandboxProvider = resolveDevLoginSandboxProvider();
  if (sandboxProvider) {
    await db
      .insert(schema.userSettings)
      .values({
        userId: user.id,
        sandboxProvider,
      })
      .onConflictDoUpdate({
        target: schema.userSettings.userId,
        set: {
          sandboxProvider,
        },
      });
  }

  const subscription = await db.query.subscription.findFirst({
    where: eq(schema.subscription.referenceId, user.id),
  });
  if (subscription) {
    await db
      .update(schema.subscription)
      .set({
        plan: "core",
        status: "active",
        periodStart: new Date(now.getTime() - 1000 * 60 * 60 * 24 * 30),
        periodEnd: new Date(now.getTime() + 1000 * 60 * 60 * 24 * 30),
        updatedAt: now,
      })
      .where(eq(schema.subscription.id, subscription.id));
  } else {
    await db
      .insert(schema.subscription)
      .values({
        id: DEV_LOGIN_SUBSCRIPTION_ID,
        plan: "core",
        referenceId: user.id,
        status: "active",
        periodStart: new Date(now.getTime() - 1000 * 60 * 60 * 24 * 30),
        periodEnd: new Date(now.getTime() + 1000 * 60 * 60 * 24 * 30),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.subscription.id,
        set: {
          plan: "core",
          referenceId: user.id,
          status: "active",
          periodStart: new Date(now.getTime() - 1000 * 60 * 60 * 24 * 30),
          periodEnd: new Date(now.getTime() + 1000 * 60 * 60 * 24 * 30),
          updatedAt: now,
        },
      });
  }

  await getUserFlags({ db, userId: user.id });
  return user;
}

function devLoginPlugin(): BetterAuthPlugin {
  return {
    id: "terragon-dev-login",
    endpoints: {
      signInDevLoginRedirect: createAuthEndpoint(
        "/sign-in/dev-login",
        {
          method: "GET",
          query: z.object({
            returnUrl: z.string().optional(),
          }),
        },
        async (ctx) => {
          if (!isDevLoginEnabled()) {
            throw new Error("Dev login is not enabled");
          }

          const user = await ensureDevLoginUser();
          const session = await ctx.context.internalAdapter.createSession(
            user.id,
            ctx,
          );
          if (!session) {
            throw new Error("Failed to create dev login session");
          }

          await setSessionCookie(ctx, { session, user });
          throw ctx.redirect(resolveDevLoginReturnUrl(ctx.query.returnUrl));
        },
      ),
      signInDevLogin: createAuthEndpoint(
        "/sign-in/dev-login",
        {
          method: "POST",
          body: z.object({
            returnUrl: z.string().optional(),
          }),
        },
        async (ctx) => {
          if (!isDevLoginEnabled()) {
            throw new Error("Dev login is not enabled");
          }

          const user = await ensureDevLoginUser();
          const session = await ctx.context.internalAdapter.createSession(
            user.id,
            ctx,
          );
          if (!session) {
            throw new Error("Failed to create dev login session");
          }

          await setSessionCookie(ctx, { session, user });
          return ctx.json({
            redirectTo: resolveDevLoginReturnUrl(ctx.body.returnUrl),
            user,
          });
        },
      ),
    },
  };
}

async function isRequiredGitHubOrgMember({
  userId,
}: {
  userId: string;
}): Promise<boolean> {
  const requiredOrg = env.GITHUB_REQUIRED_ORG.trim().toLowerCase();
  if (!requiredOrg) {
    return true;
  }

  const accessTokenResult = await auth.api.getAccessToken({
    body: { providerId: "github", userId },
  });
  const accessToken = accessTokenResult?.accessToken;
  if (!accessToken) {
    return false;
  }

  const response = await fetch(
    `https://api.github.com/user/memberships/orgs/${encodeURIComponent(requiredOrg)}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "Terragon",
      },
      cache: "no-store",
    },
  );
  if (!response.ok) {
    return false;
  }

  const membership = (await response.json()) as { state?: string };
  return membership.state === "active";
}

export const auth = betterAuth({
  account: {
    encryptOAuthTokens: true,
  },
  baseUrl:
    process.env.NEXT_PUBLIC_VERCEL_ENV !== "preview"
      ? env.BETTER_AUTH_URL
      : `https://${process.env.NEXT_PUBLIC_VERCEL_BRANCH_URL}`,
  secret: env.BETTER_AUTH_SECRET,
  database: drizzleAdapter(db, {
    provider: "pg",
    schema,
  }),
  user: {
    additionalFields: {
      signupTrialPlan: {
        type: "string",
      },
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 60, // 60 days (2 months)
    updateAge: 60 * 60 * 24, // Update session if it's older than 1 day
  },
  hooks: {
    after: createAuthMiddleware(async (context) => {
      if (context.request && context.path === "/callback/:id") {
        const url = new URL(context.request.url);
        const state = url.searchParams.get("state");
        if (state === "close") {
          // This will be handled on the client side to close the window
          return new Response(
            "<html><body><script>window.close();</script></body></html>",
            {
              status: 200,
              headers: {
                "Content-Type": "text/html",
              },
            },
          );
        }
      }
      return null;
    }),
  },
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          getPostHogServer().capture({
            distinctId: user.id,
            event: "user_created",
            properties: {
              name: user.name,
              email: user.email,
              signupMethod: "open_signup",
            },
          });

          const normalizedEmail = user.email?.trim().toLowerCase();
          if (normalizedEmail && initialAdminEmails.has(normalizedEmail)) {
            await db
              .update(schema.user)
              .set({ role: "admin" })
              .where(eq(schema.user.id, user.id));
          }

          // Create Loops contact + event (best-effort)
          try {
            if (env.LOOPS_API_KEY && user.email) {
              const loops = new LoopsClient(env.LOOPS_API_KEY);
              await loops.createContact({
                email: user.email,
                properties: {
                  name: user.name ?? undefined,
                  userId: user.id,
                  source: "signup",
                },
              });
              // Also log a user_created event for workflows
              await loops.sendEvent({
                email: user.email,
                eventName: "user_created",
                eventProperties: {
                  userId: user.id,
                },
              });
            }
          } catch (err) {
            console.warn("Loops createContact/sendEvent failed", err);
          }
        },
      },
    },
    account: {
      create: {
        after: async (account) => {
          if (
            account.providerId === "github" &&
            !(await isRequiredGitHubOrgMember({ userId: account.userId }))
          ) {
            throw new Error("GitHub organization membership required");
          }
          await maybeGrantSignupBonus({ db, userId: account.userId });
        },
      },
    },
  },
  socialProviders: {
    github: {
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
      scope: ["read:user", "user:email", "read:org", "repo", "workflow"],
      refreshAccessToken: async (encryptedRefreshToken: string) => {
        // Better Auth passes the raw DB value which is encrypted — decrypt before sending to GitHub
        const refreshToken = await symmetricDecrypt({
          key: env.BETTER_AUTH_SECRET,
          data: encryptedRefreshToken,
        });

        const body = new URLSearchParams({
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
        });

        const response = await fetch(
          "https://github.com/login/oauth/access_token",
          {
            method: "POST",
            headers: { Accept: "application/json" },
            body,
            signal: AbortSignal.timeout(10_000),
          },
        );

        const data = (await response.json()) as {
          access_token?: string;
          refresh_token?: string;
          expires_in?: number;
          refresh_token_expires_in?: number;
          error?: string;
          error_description?: string;
        };

        if (!response.ok || data.error) {
          throw new Error(
            `GitHub token refresh failed: ${data.error ?? response.status} - ${data.error_description ?? response.statusText}`,
          );
        }

        if (!data.access_token || !data.refresh_token) {
          throw new Error(
            "GitHub token refresh returned incomplete payload: missing access_token or refresh_token",
          );
        }

        return {
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          accessTokenExpiresAt: data.expires_in
            ? new Date(Date.now() + data.expires_in * 1000)
            : undefined,
          refreshTokenExpiresAt: data.refresh_token_expires_in
            ? new Date(Date.now() + data.refresh_token_expires_in * 1000)
            : undefined,
        };
      },
    },
  },
  plugins: [
    admin(),
    bearer(),
    apiKey({
      maximumNameLength: 64,
      enableMetadata: true,
      rateLimit: {
        enabled: false,
      },
    }),
    magicLink({
      expiresIn: 15 * 60, // 15 minutes
      sendMagicLink: async ({ email, url: rawUrl }) => {
        const url =
          process.env.NEXT_PUBLIC_VERCEL_ENV === "preview"
            ? rawUrl.replace(
                "https://www.terragonlabs.com",
                `https://${process.env.NEXT_PUBLIC_VERCEL_BRANCH_URL}`,
              )
            : rawUrl;
        const resend = new Resend(env.RESEND_API_KEY ?? "DUMMY_KEY");
        const result = await resend.emails.send({
          from: "Terry <onboarding@mail.terragonlabs.com>",
          to: email,
          subject: "Sign in to Terragon",
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2>Sign in to Terragon</h2>
              <p>Hello,</p>
              <p>Click the link below to sign in to your Terragon account:</p>
              <a href="${url}" style="display: inline-block; padding: 12px 24px; background-color: #000; color: #fff; text-decoration: none; border-radius: 6px; margin: 16px 0;">Sign in to Terragon</a>
              <p style="color: #666; font-size: 14px;">This link will expire in 15 minutes.</p>
              <p style="color: #666; font-size: 14px;">If you didn't request this email, you can safely ignore it.</p>
            </div>
          `,
        });
        console.log("Magic send result", result);
        if (result.error) {
          throw new Error("Error sending magic link");
        }
      },
    }),
    ...(isDevLoginEnabled() ? [devLoginPlugin()] : []),
  ],
  trustedOrigins: [
    "https://www.terragonlabs.com",
    "https://terragonlabs.com",
    process.env.NEXT_PUBLIC_VERCEL_BRANCH_URL &&
      `https://${process.env.NEXT_PUBLIC_VERCEL_BRANCH_URL}`,
    process.env.NODE_ENV === "development" && publicAppUrl(),
    process.env.NODE_ENV === "development" && nonLocalhostPublicAppUrl(),
  ].filter(Boolean) as string[],
});
