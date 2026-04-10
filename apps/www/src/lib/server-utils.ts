import { env } from "@leo/env/apps-www";
import { publicAppUrl } from "@leo/env/next-public";

/**
 * There are some cases where we need a URL that isn't the localhost one,
 * eg. When the daemon needs to connect back to the local server
 * eg. OAuth redirection urls that don't support localhost
 *
 * In cases where localhost is fine, publicAppUrl() is preferred because the user
 * is likely authed in their browser to localhost and not the non-localhost URL.
 */
export function nonLocalhostPublicAppUrl() {
  if (process.env.NODE_ENV === "development") {
    if (!env.NGROK_DOMAIN && !env.LOCALHOST_PUBLIC_DOMAIN) {
      throw new Error("LOCALHOST_PUBLIC_DOMAIN is not set");
    }
    // Deprecated, use LOCALHOST_PUBLIC_DOMAIN instead
    if (env.NGROK_DOMAIN) {
      return `https://${env.NGROK_DOMAIN}`;
    }
    return `https://${env.LOCALHOST_PUBLIC_DOMAIN}`;
  }
  if (process.env.NODE_ENV === "test") {
    return process.env.NEXT_PUBLIC_APP_URL!;
  }
  return publicAppUrl();
}
