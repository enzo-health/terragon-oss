"use client";

import { usePageBreadcrumbs } from "@/hooks/usePageBreadcrumbs";
import { GitHubPR } from "@leo/shared";
import { DataTable } from "@/components/ui/data-table";
import { PRStatusPill } from "@/components/pr-status-pill";
import { Button } from "@/components/ui/button";
import {
  refreshGitHubPR,
  postGitHubCommentForTesting,
} from "@/server-actions/admin/github";
import { useState } from "react";
import { Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { ColumnDef } from "@tanstack/react-table";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";

function RefreshButton({ pr }: { pr: GitHubPR }) {
  const router = useRouter();
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
          router.refresh();
        } finally {
          setIsRefreshing(false);
        }
      }}
    >
      {isRefreshing ? <Loader2 className="w-4 h-4 animate-spin" /> : "Refresh"}
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
        className="font-mono underline"
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
          Thread ID
          <br />
          (If created by a thread)
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
      return format(row.getValue<Date>("updatedAt"), "MMM d, yyyy h:mm a zzz");
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

export function AdminGithubAppTester() {
  usePageBreadcrumbs([
    { label: "Admin", href: "/internal/admin" },
    { label: "GitHub App Tester" },
  ]);

  const [issueOrPRUrl, setIssueOrPRUrl] = useState("");
  const [comment, setComment] = useState("");
  const [output, setOutput] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);
    setOutput(null);

    try {
      const { owner, repo, issueOrPRNumber, issueOrPRType } =
        parseIssueOrPRUrl(issueOrPRUrl);
      const result = await postGitHubCommentForTesting({
        owner,
        repo,
        comment,
        issueOrPRType,
        issueOrPRNumber,
      });
      if (result.success) {
        setOutput(result.message || "Success");
      } else {
        setError(result.error || "Unknown error");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setIsLoading(false);
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
            Repository Owner
          </label>
          <Input
            id="issue-or-pr-url"
            placeholder="https://github.com/leo-labs/leo/issues/1"
            value={issueOrPRUrl}
            onChange={(e) => setIssueOrPRUrl(e.target.value)}
            className="font-mono text-sm"
          />
        </div>
        <div>
          <label htmlFor="comment" className="block text-sm font-medium mb-2">
            Comment Body
          </label>
          <Textarea
            id="comment"
            placeholder="Enter your comment here..."
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            className="font-mono text-sm"
            rows={6}
          />
        </div>
        <Button
          type="submit"
          disabled={isLoading || !issueOrPRUrl.trim() || !comment.trim()}
        >
          {isLoading ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
              Posting...
            </>
          ) : (
            "Post Comment"
          )}
        </Button>
      </form>

      {error && (
        <div className="mt-6 p-4 bg-destructive/10 border border-destructive rounded-lg">
          <h2 className="text-lg font-semibold text-destructive mb-2">Error</h2>
          <p className="text-sm text-destructive/90 whitespace-pre-wrap font-mono">
            {error}
          </p>
        </div>
      )}

      {output && (
        <div className="mt-6 p-4 bg-muted rounded-lg">
          <h2 className="text-lg font-semibold mb-2">Comment Posted</h2>
          <pre className="text-sm whitespace-pre-wrap font-mono bg-background p-4 rounded border">
            {output}
          </pre>
        </div>
      )}
    </div>
  );
}
