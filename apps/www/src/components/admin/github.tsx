"use client";

import { usePageBreadcrumbs } from "@/hooks/usePageBreadcrumbs";
import { GitHubPR } from "@terragon/shared";
import { DataTable } from "@/components/ui/data-table";
import { PRStatusPill } from "@/components/pr-status-pill";
import { Button } from "@/components/ui/button";
import {
  refreshGitHubPR,
  postGitHubCommentForTesting,
} from "@/server-actions/admin/github";
import { useReducer, useState } from "react";
import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { ColumnDef } from "@tanstack/react-table";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

function RefreshButton({ pr }: { pr: GitHubPR }) {
  const { refresh } = useRouter();
  const [isRefreshing, setIsRefreshing] = useState(false);
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={isRefreshing}
      onClick={async () => {
        setIsRefreshing(true);
        try {
          await refreshGitHubPR({
            prNumber: pr.number,
            repoFullName: pr.repoFullName,
          });
          refresh();
          setIsRefreshing(false);
        } catch (error) {
          setIsRefreshing(false);
          throw error;
        }
      }}
    >
      {isRefreshing ? <Loader2 className="size-4 animate-spin" /> : "Refresh"}
    </Button>
  );
}

const columns: ColumnDef<GitHubPR>[] = [
  {
    accessorKey: "number",
    header: "PR #",
    cell: ({ row }) => (
      <Link
        href={`/internal/admin/github/pr/${row.original.repoFullName}/${row.original.number}`}
        className="font-mono tabular-nums underline"
      >
        {row.getValue("number")}
      </Link>
    ),
  },
  {
    accessorKey: "repoFullName",
    header: "Repo",
    cell: ({ row }) => (
      <span className="font-mono">{row.getValue("repoFullName")}</span>
    ),
  },
  {
    accessorKey: "status",
    header: "Status",
    cell: ({ row }) => {
      const pr = row.original;
      return (
        <PRStatusPill
          status={pr.status}
          checksStatus={pr.checksStatus}
          prNumber={pr.number}
          repoFullName={pr.repoFullName}
        />
      );
    },
  },
  {
    accessorKey: "threadId",
    header: () => {
      return (
        <div className="flex flex-col py-2">
          <span>Thread ID</span>
          <span className="text-xs font-normal text-mid">
            If created by a thread
          </span>
        </div>
      );
    },
    cell: ({ row }) => {
      const pr = row.original;
      if (!pr.threadId) {
        return null;
      }
      return (
        <Link
          href={`/internal/admin/thread/${pr.threadId}`}
          className="underline block max-w-[200px] truncate"
        >
          <span className="font-mono">{pr.threadId}</span>
        </Link>
      );
    },
  },
  {
    accessorKey: "updatedAt",
    header: "Updated At",
    cell: ({ row }) => {
      return (
        <span className="tabular-nums text-xs">
          {format(row.getValue<Date>("updatedAt"), "MMM d, yyyy h:mm a zzz")}
        </span>
      );
    },
  },
  {
    accessorKey: "baseRef",
    header: "Base Ref",
    cell: ({ row }) => (
      <span className="font-mono block max-w-[120px] truncate">
        {row.getValue("baseRef")}
      </span>
    ),
  },
  {
    accessorKey: "mergeableState",
    header: "Mergeable State",
    cell: ({ row }) => (
      <span className="font-mono">{row.getValue("mergeableState")}</span>
    ),
  },
  {
    accessorKey: "checksStatus",
    header: "Checks Status",
    cell: ({ row }) => (
      <span className="font-mono">{row.getValue("checksStatus")}</span>
    ),
  },
  {
    id: "actions",
    cell: ({ row }) => (
      <>
        <RefreshButton pr={row.original} />
      </>
    ),
  },
];

export function AdminGithub({ prs }: { prs: GitHubPR[] }) {
  usePageBreadcrumbs([
    { label: "Admin", href: "/internal/admin" },
    { label: "Pull Requests" },
  ]);
  return (
    <div>
      <div className="flex flex-col gap-4">
        <DataTable columns={columns} data={prs} />
      </div>
    </div>
  );
}

function parseIssueOrPRUrl(url: string): {
  owner: string;
  repo: string;
  issueOrPRType: "issue" | "pr";
  issueOrPRNumber: number;
} {
  const match = url.match(
    /https:\/\/github\.com\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)/,
  );
  if (!match) {
    throw new Error("Invalid URL");
  }
  return {
    owner: match[1]!,
    repo: match[2]!,
    issueOrPRType: match[3] === "issues" ? "issue" : "pr",
    issueOrPRNumber: parseInt(match[4]!, 10),
  };
}

type GithubTesterState = {
  issueOrPRUrl: string;
  comment: string;
  output: string | null;
  error: string | null;
  isLoading: boolean;
};

type GithubTesterAction =
  | { type: "set-issue-or-pr-url"; issueOrPRUrl: string }
  | { type: "set-comment"; comment: string }
  | { type: "submit-start" }
  | { type: "submit-success"; output: string }
  | { type: "submit-result-error"; error: string };

function githubTesterReducer(
  state: GithubTesterState,
  action: GithubTesterAction,
): GithubTesterState {
  switch (action.type) {
    case "set-issue-or-pr-url":
      return { ...state, issueOrPRUrl: action.issueOrPRUrl };
    case "set-comment":
      return { ...state, comment: action.comment };
    case "submit-start":
      return { ...state, isLoading: true, error: null, output: null };
    case "submit-success":
      return {
        ...state,
        isLoading: false,
        output: action.output,
      };
    case "submit-result-error":
      return {
        ...state,
        isLoading: false,
        error: action.error,
      };
  }
}

export function AdminGithubAppTester() {
  usePageBreadcrumbs([
    { label: "Admin", href: "/internal/admin" },
    { label: "GitHub App Tester" },
  ]);

  const [state, dispatch] = useReducer(githubTesterReducer, {
    issueOrPRUrl: "",
    comment: "",
    output: null,
    error: null,
    isLoading: false,
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    dispatch({ type: "submit-start" });

    try {
      const { owner, repo, issueOrPRNumber, issueOrPRType } = parseIssueOrPRUrl(
        state.issueOrPRUrl,
      );
      const result = await postGitHubCommentForTesting({
        owner,
        repo,
        comment: state.comment,
        issueOrPRType,
        issueOrPRNumber,
      });
      if (result.success) {
        dispatch({
          type: "submit-success",
          output: result.message || "Success",
        });
      } else {
        dispatch({
          type: "submit-result-error",
          error: result.error || "Unknown error",
        });
      }
    } catch (err) {
      dispatch({
        type: "submit-result-error",
        error: err instanceof Error ? err.message : "Unknown error",
      });
    }
  };

  return (
    <div className="max-w-4xl">
      <p className="text-muted-foreground mb-6">
        Test leaving a comment on a GitHub issue or PR
      </p>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label
            htmlFor="issue-or-pr-url"
            className="block text-sm font-medium mb-2"
          >
            Issue or PR URL
          </label>
          <Input
            id="issue-or-pr-url"
            placeholder="https://github.com/terragon-labs/terragon/issues/1"
            value={state.issueOrPRUrl}
            onChange={(e) =>
              dispatch({
                type: "set-issue-or-pr-url",
                issueOrPRUrl: e.target.value,
              })
            }
            className="font-mono text-sm"
          />
        </div>
        <div>
          <label htmlFor="comment" className="block text-sm font-medium mb-2">
            Comment Body
          </label>
          <Textarea
            id="comment"
            placeholder="Enter your comment here…"
            value={state.comment}
            onChange={(e) =>
              dispatch({
                type: "set-comment",
                comment: e.target.value,
              })
            }
            className="font-mono text-sm"
            rows={6}
          />
        </div>
        <Button
          type="submit"
          disabled={
            state.isLoading ||
            !state.issueOrPRUrl.trim() ||
            !state.comment.trim()
          }
        >
          {state.isLoading ? (
            <>
              <Loader2 className="size-4 animate-spin mr-2" />
              Posting…
            </>
          ) : (
            "Post Comment"
          )}
        </Button>
      </form>

      {state.error && (
        <div className="mt-6 p-4 bg-error/10 border border-error/40 rounded-2xl">
          <h2 className="text-lg font-semibold text-error-strong mb-2">
            Error
          </h2>
          <p className="text-sm text-error-strong/90 whitespace-pre-wrap font-mono">
            {state.error}
          </p>
        </div>
      )}

      {state.output && (
        <div className="mt-6 p-4 bg-card rounded-2xl border border-hairline">
          <h2 className="text-lg font-semibold mb-2">Comment Posted</h2>
          <pre className="text-sm whitespace-pre-wrap font-mono bg-sunken text-foreground p-4 rounded-xl border border-hairline">
            {state.output}
          </pre>
        </div>
      )}
    </div>
  );
}
