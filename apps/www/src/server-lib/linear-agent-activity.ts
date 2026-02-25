/**
 * Linear Agent activity emission helpers.
 *
 * Uses `LinearClient.createAgentActivity()` from @linear/sdk (typed SDK — no raw GraphQL).
 * Activity content shapes per Linear Agent Interaction docs:
 *   - thought: { type: "thought", body: string }
 *   - action:  { type: "action", action: string, result?: string }
 *   - response: { type: "response", body: string }
 *   - error:   { type: "error", body: string }
 */

import { LinearClient } from "@linear/sdk";

/** Injectable factory type for testability. */
export type LinearClientFactory = (accessToken: string) => LinearClient;

/** Default factory creates a LinearClient with OAuth access token. */
const defaultClientFactory: LinearClientFactory = (accessToken: string) =>
  new LinearClient({ accessToken });

export type AgentActivityContent =
  | { type: "thought"; body: string }
  | { type: "action"; action: string; result?: string }
  | { type: "response"; body: string }
  | { type: "error"; body: string };

/**
 * Emit a Linear agent activity for a session.
 *
 * All errors are caught and logged — never throws.
 *
 * @param opts.agentSessionId - Linear agent session ID
 * @param opts.accessToken - OAuth access token for the workspace installation
 * @param opts.content - Activity content (typed per Linear API shapes)
 * @param opts.createClient - Injectable factory for testability (defaults to real LinearClient)
 */
export async function emitAgentActivity({
  agentSessionId,
  accessToken,
  content,
  createClient = defaultClientFactory,
}: {
  agentSessionId: string;
  accessToken: string;
  content: AgentActivityContent;
  createClient?: LinearClientFactory;
}): Promise<void> {
  try {
    const client = createClient(accessToken);
    await client.createAgentActivity({
      agentSessionId,
      content,
    });
  } catch (error) {
    console.error("[linear-agent-activity] Failed to emit activity", {
      agentSessionId,
      contentType: content.type,
      error,
    });
  }
}

/**
 * Update the Linear agent session with external URLs (e.g. Terragon task URL).
 *
 * All errors are caught and logged — never throws.
 *
 * @param opts.sessionId - Linear agent session ID
 * @param opts.accessToken - OAuth access token for the workspace installation
 * @param opts.externalUrls - Array of external URLs to set on the session
 * @param opts.createClient - Injectable factory for testability
 */
export async function updateAgentSession({
  sessionId,
  accessToken,
  externalUrls,
  createClient = defaultClientFactory,
}: {
  sessionId: string;
  accessToken: string;
  externalUrls: string[];
  createClient?: LinearClientFactory;
}): Promise<void> {
  try {
    const client = createClient(accessToken);
    // externalUrls is typed as AgentSessionExternalUrlInput[] in the SDK,
    // but runtime behavior accepts plain string URLs. Cast via unknown to satisfy TypeScript.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await client.updateAgentSession(sessionId, {
      externalUrls: externalUrls as any,
    });
  } catch (error) {
    console.error("[linear-agent-activity] Failed to update agent session", {
      sessionId,
      externalUrls,
      error,
    });
  }
}
