import * as schema from "@terragon/shared/db/schema";
import { eq } from "drizzle-orm";
import { betterAuth } from "better-auth";
import {
  admin,
  apiKey,
  bearer,
  createAuthMiddleware,
  magicLink,
} from "better-auth/plugins";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { db } from "./db";
import { env } from "@terragon/env/apps-www";
import { getPostHogServer } from "./posthog-server";
import { nonLocalhostPublicAppUrl } from "./server-utils";
import { publicAppUrl } from "@terragon/env/next-public";
import { maybeGrantSignupBonus } from "@/server-lib/credits";
import { LoopsClient } from "loops";
import { Resend } from "resend";

const initialAdminEmails = new Set(
  env.INITIAL_ADMIN_EMAILS.split(",")
    .map((email) => email.trim().toLowerCase())
    .filter((email) => email.length > 0),
);

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
          await maybeGrantSignupBonus({ db, userId: account.userId });
        },
      },
    },
  },
  socialProviders: {
    github: {
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
      scope: ["read:user", "user:email", "repo", "workflow"],
    },
  },
  plugins: [
    admin(),
    bearer(),
    apiKey({
      maximumNameLength: 64,
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
  ],
  trustedOrigins: [
    "www.terragonlabs.com",
    "terragonlabs.com",
    process.env.NEXT_PUBLIC_VERCEL_BRANCH_URL &&
      `https://${process.env.NEXT_PUBLIC_VERCEL_BRANCH_URL}`,
    process.env.NODE_ENV === "development" && publicAppUrl(),
    process.env.NODE_ENV === "development" && nonLocalhostPublicAppUrl(),
  ].filter(Boolean) as string[],
});
