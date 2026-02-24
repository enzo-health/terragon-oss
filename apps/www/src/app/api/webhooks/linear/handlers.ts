import { LinearClient } from "@linear/sdk";
import { env } from "@terragon/env/apps-www";
import { publicAppUrl } from "@terragon/env/next-public";
import { db } from "@/lib/db";
import {
  getLinearAccountForLinearUserId,
  getLinearSettingsForUserAndOrg,
} from "@terragon/shared/model/linear";
import { getFeatureFlagForUser } from "@terragon/shared/model/feature-flags";
import { getUserFlags } from "@terragon/shared/model/user-flags";
import { getAccessInfoForUser } from "@/lib/subscription";
import { getUserCredentials } from "@/server-lib/user-credentials";
import { getDefaultModel } from "@/lib/default-ai-model";
import { newThreadInternal } from "@/server-lib/new-thread-internal";
import { formatThreadContext } from "@/server-lib/ext-thread-context";

/**
 * Webhook payload shape for Linear Comment.create events.
 * SDK-generated types don't match webhook payloads exactly (flat IDs vs nested objects),
 * so we define a minimal shape here.
 */
interface LinearCommentWebhookPayload {
  action: string;
  type: string;
  organizationId: string;
  webhookId?: string;
  webhookTimestamp?: number;
  actor?: {
    id: string;
    name?: string;
    type?: string;
  };
  data: {
    id: string;
    body: string;
    createdAt: string;
    issueId?: string;
    userId?: string;
  };
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Detect if the comment body contains the mention handle.
 * Case-insensitive, regex-escaped.
 */
function containsMention(commentBody: string, handle: string): boolean {
  const pattern = new RegExp(escapeRegex(handle), "i");
  return pattern.test(commentBody);
}

/**
 * Extract GitHub repo full name from a GitHub attachment URL.
 * e.g. "https://github.com/owner/repo/pull/123" -> "owner/repo"
 */
function extractGitHubRepoFromUrl(url: string): string | null {
  const match = url.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+)(?:\/|$)/);
  return match?.[1] ?? null;
}

function getLinearClient(): LinearClient {
  if (!env.LINEAR_API_KEY) {
    throw new Error("LINEAR_API_KEY is not configured");
  }
  return new LinearClient({ apiKey: env.LINEAR_API_KEY });
}

/**
 * Post a comment to a Linear issue.
 * The body must NEVER contain the mention handle to prevent self-triggering loops.
 */
async function postLinearComment(
  linearClient: LinearClient,
  issueId: string,
  body: string,
): Promise<void> {
  await linearClient.createComment({ issueId, body });
}

/**
 * Build the message to send to the Terragon thread with issue context.
 */
export function buildLinearMentionMessage({
  issueIdentifier,
  issueTitle,
  issueDescription,
  issueUrl,
  commentBody,
  attachments,
}: {
  issueIdentifier: string;
  issueTitle: string;
  issueDescription: string | null | undefined;
  issueUrl: string;
  commentBody: string;
  attachments: Array<{
    title: string;
    url: string;
    sourceType: string | null | undefined;
  }>;
}): string {
  const messageParts: string[] = [];

  // Issue context
  messageParts.push(
    `You were mentioned in Linear issue ${issueIdentifier}: ${issueTitle}`,
  );

  if (issueDescription) {
    messageParts.push(`**Issue description:**\n${issueDescription}`);
  }

  // Comment that triggered the mention
  messageParts.push(`**Comment:**\n${commentBody}`);

  // Attachments
  if (attachments.length > 0) {
    const attachmentEntries = attachments.map((a) => ({
      author: a.sourceType ?? "attachment",
      body: `[${a.title}](${a.url})`,
    }));
    const formattedAttachments = formatThreadContext(attachmentEntries);
    if (formattedAttachments) {
      messageParts.push(`**Attachments:**\n${formattedAttachments}`);
    }
  }

  messageParts.push(
    "Please work on this task. Your work will be sent to the user once you're done.",
  );
  messageParts.push(issueUrl);

  return messageParts.join("\n\n");
}

export async function handleCommentCreated(
  payload: LinearCommentWebhookPayload,
): Promise<void> {
  console.log("[linear webhook] Processing comment created", {
    commentId: payload.data.id,
    organizationId: payload.organizationId,
  });

  // Empty handle guard: skip all processing if handle is empty
  const mentionHandle = env.LINEAR_MENTION_HANDLE?.trim();
  if (!mentionHandle) {
    console.warn(
      "[linear webhook] LINEAR_MENTION_HANDLE is empty, skipping processing",
    );
    return;
  }

  // Check for mention in comment body
  const commentBody = payload.data.body;
  if (!containsMention(commentBody, mentionHandle)) {
    return;
  }

  const organizationId = payload.organizationId;
  const issueId = payload.data.issueId;
  const commentId = payload.data.id;
  const linearUserId = payload.data.userId;

  if (!issueId) {
    console.error("[linear webhook] No issueId in comment data");
    return;
  }

  if (!linearUserId) {
    console.error("[linear webhook] No userId in comment data");
    return;
  }

  const linearClient = getLinearClient();

  // Resolve Linear user to Terragon user
  const linearAccount = await getLinearAccountForLinearUserId({
    db,
    organizationId,
    linearUserId,
  });

  if (!linearAccount) {
    console.error(
      `[linear webhook] No linked account for Linear user ${linearUserId} in org ${organizationId}`,
    );
    // Post error comment - must NOT contain mention handle
    await postLinearComment(
      linearClient,
      issueId,
      `Could not find a linked Terragon account for this Linear user. Please connect your Linear account in settings: ${publicAppUrl()}/settings/integrations`,
    );
    return;
  }

  // Check feature flag for resolved user
  const linearIntegrationEnabled = await getFeatureFlagForUser({
    db,
    userId: linearAccount.userId,
    flagName: "linearIntegration",
  });
  if (!linearIntegrationEnabled) {
    console.log(
      `[linear webhook] linearIntegration feature flag disabled for user ${linearAccount.userId}`,
    );
    return;
  }

  // Check user access tier
  const accessInfo = await getAccessInfoForUser(linearAccount.userId);
  if (accessInfo.tier === "none") {
    console.log(
      `[linear webhook] User ${linearAccount.userId} has no access tier`,
    );
    await postLinearComment(
      linearClient,
      issueId,
      `To use Terragon from Linear, please set up billing here: ${publicAppUrl()}/settings/billing`,
    );
    return;
  }

  // Get Linear settings for default repo and model
  const linearSettings = await getLinearSettingsForUserAndOrg({
    db,
    userId: linearAccount.userId,
    organizationId,
  });

  // Fetch issue details and attachments in parallel
  const issue = await linearClient.issue(issueId);
  const attachmentsConnection = await issue.attachments({ first: 20 });
  const attachments = attachmentsConnection?.nodes ?? [];

  // Try to extract GitHub repo from attachments
  let githubRepoFullName: string | null = null;
  for (const attachment of attachments) {
    if (attachment.sourceType === "github" && attachment.url) {
      const repo = extractGitHubRepoFromUrl(attachment.url);
      if (repo) {
        githubRepoFullName = repo;
        break;
      }
    }
  }

  // Fall back to settings default
  if (!githubRepoFullName) {
    githubRepoFullName = linearSettings?.defaultRepoFullName ?? null;
  }

  if (!githubRepoFullName) {
    console.error(
      `[linear webhook] No GitHub repo for user ${linearAccount.userId}`,
    );
    await postLinearComment(
      linearClient,
      issueId,
      `No default repository configured and no GitHub attachment found on this issue. Please set a default repository in settings: ${publicAppUrl()}/settings/integrations`,
    );
    return;
  }

  // Determine model
  const defaultModel = await (async () => {
    if (linearSettings?.defaultModel) {
      return linearSettings.defaultModel;
    }
    const [userFlags, userCredentials] = await Promise.all([
      getUserFlags({ db, userId: linearAccount.userId }),
      getUserCredentials({ userId: linearAccount.userId }),
    ]);
    return getDefaultModel({ userFlags, userCredentials });
  })();

  // Build message
  const formattedMessage = buildLinearMentionMessage({
    issueIdentifier: issue.identifier,
    issueTitle: issue.title,
    issueDescription: issue.description,
    issueUrl: issue.url,
    commentBody,
    attachments: attachments.map((a) => ({
      title: a.title,
      url: a.url,
      sourceType: a.sourceType,
    })),
  });

  console.log(
    "[linear webhook] Creating thread for user",
    linearAccount.userId,
  );

  const { threadId } = await newThreadInternal({
    userId: linearAccount.userId,
    message: {
      type: "user",
      model: defaultModel,
      parts: [
        {
          type: "text",
          text: formattedMessage,
        },
      ],
      timestamp: new Date().toISOString(),
    },
    parentThreadId: undefined,
    parentToolId: undefined,
    githubRepoFullName,
    baseBranchName: null,
    headBranchName: null,
    sourceType: "linear-mention",
    sourceMetadata: {
      type: "linear-mention",
      organizationId,
      issueId,
      issueIdentifier: issue.identifier,
      commentId,
      issueUrl: issue.url,
    },
  });

  // Post acknowledgment comment - body must NOT contain the mention handle
  await postLinearComment(
    linearClient,
    issueId,
    `Task created: ${publicAppUrl()}/task/${threadId}`,
  );

  console.log("[linear webhook] Successfully created thread", threadId);
}
