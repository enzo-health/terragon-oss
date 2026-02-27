import {
  OAuth2Client,
  generateState,
  generateCodeVerifier,
  CodeChallengeMethod,
} from "arctic";

export type AuthType = "account-link" | "api-key";

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

// Using this endpoint gets you a token that can be used directly with claude code.
const CLAUDE_AUTH_ENDPOINT = "https://claude.ai/oauth/authorize";

// Using this endpoint gets you a token that be used to create an API key.
const ANTHROPIC_AUTH_ENDPOINT = "https://console.anthropic.com/oauth/authorize";
const ANTHROPIC_API_KEY_URL =
  "https://api.anthropic.com/api/oauth/claude_cli/create_api_key";

// In both cases, the redirect URI and token endpoint are the same.
const REDIRECT_URI = "https://console.anthropic.com/oauth/code/callback";
const TOKEN_ENDPOINT = "https://console.anthropic.com/v1/oauth/token";
const SCOPES = ["org:create_api_key", "user:inference", "user:profile"];

// Create a custom OAuth2 client for Claude
const claudeOAuth = new OAuth2Client(
  CLIENT_ID,
  null, // No client secret for public clients
  REDIRECT_URI,
);

interface ClaudeTokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
  account?: {
    uuid: string;
    email_address: string;
  };
  organization?: {
    uuid: string;
    name: string;
  };
}

// Generate authorization URL with PKCE
export async function createAuthorizationURL({
  type,
}: {
  type: AuthType;
}): Promise<{
  url: URL;
  codeVerifier: string;
  state: string;
}> {
  const state = generateState();
  const codeVerifier = generateCodeVerifier();
  const url = claudeOAuth.createAuthorizationURLWithPKCE(
    type === "account-link" ? CLAUDE_AUTH_ENDPOINT : ANTHROPIC_AUTH_ENDPOINT,
    state,
    CodeChallengeMethod.S256,
    codeVerifier,
    SCOPES,
  );
  return { url, codeVerifier, state };
}

// Exchange authorization code for tokens
export async function exchangeAuthorizationCode({
  code,
  codeVerifier,
  state,
}: {
  code: string;
  codeVerifier: string;
  state: string;
}): Promise<ClaudeTokenResponse> {
  // Arctic's validateAuthorizationCode expects the token endpoint to return
  // a standard OAuth2 response, but Claude's API might have a different format
  // So we'll make the request manually to handle the response properly
  const params = {
    grant_type: "authorization_code",
    code: code,
    redirect_uri: REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: codeVerifier,
    state: state,
  };
  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(params),
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token exchange failed: ${error}`);
  }
  return response.json();
}

// Refresh an access token using a refresh token
export async function refreshAccessToken(
  refreshToken: string,
): Promise<ClaudeTokenResponse> {
  const params = {
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CLIENT_ID,
  };

  const response = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token refresh failed: ${error}`);
  }

  return response.json();
}

export async function createAnthropicAPIKey(accessToken: string) {
  const response = await fetch(ANTHROPIC_API_KEY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to create Anthropic API key: ${error}`);
  }
  const json = await response.json();
  if (!json.raw_key) {
    throw new Error("Failed to create Anthropic API key");
  }
  return json.raw_key;
}
