import { createAuthClient } from "better-auth/react";
import { publicAppUrl } from "@terragon/env/next-public";
import {
  apiKeyClient,
  magicLinkClient,
  adminClient,
} from "better-auth/client/plugins";

export const authClient = createAuthClient({
  baseURL: publicAppUrl(),
  plugins: [apiKeyClient(), magicLinkClient(), adminClient()],
});
