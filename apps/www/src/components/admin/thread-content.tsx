"use client";

import { useState, useCallback, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { SingleEntityTable } from "./single-entity-table";
import { EntityIdInput } from "./entity-id-input";
import { Button } from "@/components/ui/button";
import { PRStatusPill } from "@/components/pr-status-pill";
import { GitDiffStats } from "@/components/admin/git-diff-stats";
import { usePageBreadcrumbs } from "@/hooks/usePageBreadcrumbs";
import { Copy, Check, Download } from "lucide-react";
import { toast } from "sonner";
import { downloadClaudeSessionJSONL } from "@/server-actions/admin/thread";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { ChatMessages } from "@/components/chat/chat-messages";
import { toUIMessages } from "@/components/chat/toUIMessages";
import { ThreadChatInfoFull } from "@leo/shared";
import { ensureAgent } from "@leo/agent/utils";
import { type ThreadForAdmin } from "@/server-actions/admin/thread";
import { getPrimaryThreadChat } from "@leo/shared/utils/thread-utils";
import { ThreadStatusIndicator } from "../thread-status";
import { ThreadAgentIcon } from "../thread-agent-icon";

type Keys = keyof ThreadForAdmin | `threadChats.${keyof ThreadChatInfoFull}`;

const threadKeys: Keys[] = [
  "id",
  "user",
  "name",
  "sandboxStatus",
  "bootingSubstatus",
  "threadChats.status",
  "threadChats.agent",
  "threadChats.agentVersion",
  "threadChats.permissionMode",
  "threadChats.sessionId",
  "threadChats.errorMessage",
  "threadChats.errorMessageInfo",
  "threadChats.contextLength",
  "sourceType",
  "sourceMetadata",
  "skipSetup",
  "disableGitCheckpointing",
  "visibility",
  "automationId",
  "githubRepoFullName",
  "repoBaseBranchName",
  "branchName",
  "gitDiffStats",
  "githubPRNumber",
  "githubIssueNumber",
  "sandboxSize",
  "sandboxProvider",
  "codesandboxId",
  "archived",
  "createdAt",
  "updatedAt",
  "parentThreadId",
  "parentToolId",
];

export function AdminThreadIdInput() {
  const router = useRouter();
  return (
    <EntityIdInput
      placeholder="Enter Thread ID..."
      onSubmit={(threadId) => {
        router.push(`/internal/admin/thread/${threadId}`);
      }}
    />
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Copied");
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy", err);
      toast.error("Failed to copy");
    }
  };

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={copyToClipboard}
      className="h-6 w-6"
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
    </Button>
  );
}

function DownloadJSONLButton({
  threadId,
  sessionId,
}: {
  threadId: string;
  sessionId: string;
}) {
  const [downloading, setDownloading] = useState(false);

  const handleDownload = async () => {
    try {
      setDownloading(true);
      const contents = await downloadClaudeSessionJSONL({
        threadId,
        sessionId,
      });
      if (!contents) {
        toast.error("JSONL file not found");
        return;
      }

      const blob = new Blob([contents], { type: "application/x-ndjson" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `claude-session-${sessionId}.jsonl`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      toast.success("Downloaded JSONL file");
    } catch (err) {
      console.error("Failed to download JSONL", err);
      toast.error("Failed to download JSONL");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={handleDownload}
      disabled={downloading}
      className="h-6 w-6"
    >
      <Download className="h-3 w-3" />
    </Button>
  );
}

export function AdminThreadContent({
  threadIdOrNull,
  threadOrNull,
}: {
  threadIdOrNull: string | null;
  threadOrNull: ThreadForAdmin | null;
}) {
  usePageBreadcrumbs([
    { label: "Admin", href: "/internal/admin" },
    { label: "Threads", href: "/internal/admin/thread" },
    ...(threadIdOrNull ? [{ label: threadIdOrNull }] : []),
  ]);
  const threadChat = threadOrNull ? getPrimaryThreadChat(threadOrNull) : null;
  const router = useRouter();
  const searchParams = useSearchParams();
  const currentTab = searchParams.get("tab") || "details";
  const [showMessagesJson, setShowMessagesJson] = useState(false);
  const uiMessages = useMemo(() => {
    if (!threadChat) {
      return null;
    }
    const agent = ensureAgent(threadChat?.agent);
    return threadChat?.messages
      ? toUIMessages({ agent, dbMessages: threadChat?.messages })
      : null;
  }, [threadChat]);

  const handleTabChange = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams);
      params.set("tab", value);
      router.push(
        `/internal/admin/thread/${threadIdOrNull}?${params.toString()}`,
      );
    },
    [router, searchParams, threadIdOrNull],
  );

  return (
    <div className="flex flex-col justify-start h-full w-full">
      <div className="space-y-6">
        <AdminThreadIdInput />

        {threadIdOrNull && !threadOrNull && (
          <p className="font-bold text-destructive">Thread not found</p>
        )}
        {threadOrNull && (
          <Tabs
            value={currentTab}
            onValueChange={handleTabChange}
            className="w-full"
          >
            <TabsList>
              <TabsTrigger value="details">Details</TabsTrigger>
              <TabsTrigger value="messages">Messages</TabsTrigger>
            </TabsList>

            <TabsContent value="details" className="mt-4">
              <div className="flex flex-col gap-2">
                <div className="flex flex-col gap-2">
                  <h2 className="text-md font-semibold underline">
                    Thread Details
                  </h2>
                  <SingleEntityTable
                    entity={threadOrNull}
                    rowKeys={[...threadKeys, "childThreads"]}
                    renderKey={(key) => {
                      if (key === "user") {
                        return {
                          type: "link",
                          label: threadOrNull?.user.name,
                          href: `/internal/admin/user/${threadOrNull?.user.id}`,
                        };
                      }
                      if (
                        key === "parentThreadId" &&
                        threadOrNull?.parentThreadId
                      ) {
                        return {
                          type: "link",
                          label: threadOrNull?.parentThreadId,
                          href: `/internal/admin/thread/${threadOrNull?.parentThreadId}`,
                        };
                      }
                      if (
                        key === "codesandboxId" &&
                        threadOrNull?.sandboxProvider
                      ) {
                        return (
                          <div className="flex items-center gap-2">
                            <Link
                              className="underline"
                              href={`/internal/admin/sandbox/${threadOrNull.sandboxProvider}/${threadOrNull.codesandboxId}`}
                            >
                              {threadOrNull.codesandboxId}
                            </Link>
                            {threadOrNull.codesandboxId && (
                              <CopyButton text={threadOrNull.codesandboxId} />
                            )}
                          </div>
                        );
                      }
                      if (key === "githubPRNumber") {
                        return (
                          <div className="flex items-center gap-2">
                            {threadOrNull.githubPRNumber && (
                              <Link
                                className="underline font-mono"
                                href={`/internal/admin/github/pr/${threadOrNull.githubRepoFullName}/${threadOrNull.githubPRNumber}`}
                              >
                                #{threadOrNull.githubPRNumber}
                              </Link>
                            )}
                            {threadOrNull.prStatus &&
                              threadOrNull.githubPRNumber && (
                                <PRStatusPill
                                  repoFullName={threadOrNull.githubRepoFullName}
                                  prNumber={threadOrNull.githubPRNumber}
                                  status={threadOrNull.prStatus}
                                  checksStatus={threadOrNull.prChecksStatus}
                                />
                              )}
                          </div>
                        );
                      }
                      if (key === "githubRepoFullName") {
                        return (
                          <div className="flex items-center gap-2">
                            {threadOrNull.githubRepoFullName}
                            <Link
                              className="underline"
                              href={`/internal/admin/environment?id=${threadOrNull.id}`}
                            >
                              (Environment)
                            </Link>
                          </div>
                        );
                      }
                      if (key === "gitDiffStats") {
                        return (
                          <GitDiffStats diffStats={threadOrNull.gitDiffStats} />
                        );
                      }
                      if (key === "threadChats.status") {
                        return (
                          <div className="flex items-center gap-2">
                            <ThreadStatusIndicator
                              thread={{ ...threadOrNull, isUnread: false }}
                            />
                            {threadOrNull.threadChats
                              .map((chat) => chat.status)
                              .join(", ")}
                          </div>
                        );
                      }
                      if (key === "threadChats.agent") {
                        return (
                          <div className="flex items-center gap-2">
                            <ThreadAgentIcon thread={threadOrNull} />
                            {threadOrNull.threadChats
                              .map((chat) => chat.agent)
                              .join(", ")}
                          </div>
                        );
                      }
                      if (key === "threadChats.sessionId") {
                        return (
                          <div className="flex flex-col gap-2">
                            {threadOrNull.threadChats.map((chat) => (
                              <div
                                key={chat.id}
                                className="flex items-center gap-2"
                              >
                                {chat.sessionId}
                                {chat.agent === "claudeCode" &&
                                  chat.sessionId && (
                                    <DownloadJSONLButton
                                      threadId={chat.threadId}
                                      sessionId={chat.sessionId}
                                    />
                                  )}
                              </div>
                            ))}
                          </div>
                        );
                      }
                      if (key.startsWith("threadChats.")) {
                        return JSON.stringify(
                          threadOrNull.threadChats.map((chat) => {
                            const keyParts = key.split(".");
                            return (
                              chat[
                                keyParts[1] as keyof ThreadChatInfoFull
                              ]?.toString() ?? "null"
                            );
                          }),
                          null,
                          2,
                        );
                      }
                      if (key === "childThreads") {
                        return !!threadOrNull?.childThreads.length ? (
                          <div className="space-y-1">
                            {threadOrNull.childThreads.map((child) => (
                              <div
                                key={child.id}
                                className="flex items-center gap-2"
                              >
                                <Link
                                  className="underline text-sm"
                                  href={`/internal/admin/thread/${child.id}`}
                                >
                                  {child.id}
                                </Link>
                                {child.parentToolId && (
                                  <span className="text-xs text-muted-foreground">
                                    (tool: {child.parentToolId})
                                  </span>
                                )}
                              </div>
                            ))}
                          </div>
                        ) : (
                          "None"
                        );
                      }
                    }}
                  />
                </div>
              </div>
            </TabsContent>

            <TabsContent value="messages" className="mt-4">
              <div className="flex flex-col gap-4">
                <div className="flex items-center justify-between">
                  <h2 className="text-md font-semibold">Messages</h2>

                  {threadChat?.messages && (
                    <div className="flex items-center gap-2">
                      <Label
                        className="text-xs text-muted-foreground"
                        htmlFor="messages-json"
                      >
                        JSON
                        <Switch
                          id="messages-json"
                          checked={showMessagesJson}
                          onCheckedChange={setShowMessagesJson}
                        />
                      </Label>
                      <CopyButton
                        text={JSON.stringify(threadChat.messages, null, 2)}
                      />
                    </div>
                  )}
                </div>
                {showMessagesJson ? (
                  threadChat?.messages ? (
                    <pre className="bg-muted p-4 rounded-lg overflow-auto text-xs">
                      {JSON.stringify(threadChat.messages, null, 2)}
                    </pre>
                  ) : (
                    <p className="text-muted-foreground">
                      No messages available
                    </p>
                  )
                ) : uiMessages ? (
                  <ChatMessages messages={uiMessages} isAgentWorking={false} />
                ) : (
                  <p className="text-muted-foreground">No messages available</p>
                )}
              </div>
            </TabsContent>
          </Tabs>
        )}
      </div>
    </div>
  );
}
