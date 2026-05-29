import { NextResponse } from "next/server";
import {
  getDaemonTokenAuthContextOrNull,
  hasDaemonProviderScope,
} from "@/lib/auth-server";
import { refreshCodexChatGptAuthTokens } from "@/agent/msg/codexCredentials";

async function readRequestContext(request: Request): Promise<{
  threadId?: string;
  threadChatId?: string;
  previousAccountId?: string;
}> {
  try {
    const body = (await request.json()) as {
      threadId?: unknown;
      threadChatId?: unknown;
      previousAccountId?: unknown;
    };
    return {
      threadId: typeof body.threadId === "string" ? body.threadId : undefined,
      threadChatId:
        typeof body.threadChatId === "string" ? body.threadChatId : undefined,
      previousAccountId:
        typeof body.previousAccountId === "string"
          ? body.previousAccountId
          : undefined,
    };
  } catch {
    return {};
  }
}

export async function POST(request: Request) {
  const authContext = await getDaemonTokenAuthContextOrNull(request);
  const claims = authContext?.claims ?? null;
  if (!authContext || !claims) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (
    claims.agent !== "codex" ||
    claims.transportMode !== "codex-app-server" ||
    claims.exp <= Date.now() ||
    !hasDaemonProviderScope(claims, "openai") ||
    !claims.codexOAuthCredentialId
  ) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const requestContext = await readRequestContext(request);
  if (
    requestContext.threadId !== claims.threadId ||
    requestContext.threadChatId !== claims.threadChatId
  ) {
    return NextResponse.json(
      { error: "run_context_mismatch" },
      { status: 409 },
    );
  }

  const tokens = await refreshCodexChatGptAuthTokens({
    userId: authContext.userId,
    credentialId: claims.codexOAuthCredentialId,
  });
  if (!tokens) {
    return NextResponse.json(
      { error: "chatgpt_auth_tokens_unavailable" },
      { status: 409 },
    );
  }
  if (
    requestContext.previousAccountId &&
    requestContext.previousAccountId !== tokens.chatgptAccountId
  ) {
    return NextResponse.json(
      { error: "chatgpt_account_mismatch" },
      { status: 409 },
    );
  }

  return NextResponse.json(tokens);
}
