import { cn } from "@/lib/utils";
import { GithubCheckStatus, GithubPRStatus } from "@terragon/shared";
import {
  GitPullRequestArrow,
  GitMerge,
  GitPullRequestClosed,
  GitPullRequestDraft,
} from "lucide-react";
import { memo } from "react";

const checksSuccessIcon =
  "https://github.githubassets.com/favicons/favicon-success.png";
const checksSuccessDarkIcon =
  "https://github.githubassets.com/favicons/favicon-success-dark.png";
const checksFailureIcon =
  "https://github.githubassets.com/favicons/favicon-failure.png";
const checksFailureDarkIcon =
  "https://github.githubassets.com/favicons/favicon-failure-dark.png";
const checksPendingIcon =
  "https://github.githubassets.com/favicons/favicon-pending.png";
const checksPendingDarkIcon =
  "https://github.githubassets.com/favicons/favicon-pending-dark.png";

export const PRStatusPill = memo(function PRStatusPill({
  status,
  checksStatus,
  prNumber,
  repoFullName,
}: {
  status: GithubPRStatus;
  checksStatus: GithubCheckStatus | null;
  prNumber: number;
  repoFullName: string;
}) {
  const iconClassName = "size-3.5 mr-1";
  const getIcon = () => {
    switch (status) {
      case "open":
        return (
          <GitPullRequestArrow
            className={cn(
              iconClassName,
              "shrink-0 text-[var(--diff-added-fg)]/70",
            )}
          />
        );
      case "closed":
        return (
          <GitPullRequestClosed
            className={cn(
              iconClassName,
              "shrink-0 text-[var(--diff-removed-fg)]/70",
            )}
          />
        );
      case "merged":
        return (
          <GitMerge
            className={cn(iconClassName, "shrink-0 text-purple-600/70")}
          />
        );
      case "draft":
        return (
          <GitPullRequestDraft
            className={cn(iconClassName, "shrink-0 text-muted-foreground/70")}
          />
        );
    }
  };

  const checkStatusClassName = "size-3.5";
  let checkStatusIcon = null;
  if (status === "open" || status === "draft") {
    if (checksStatus === "failure") {
      checkStatusIcon = (
        <>
          <img
            src={checksFailureIcon}
            alt="Checks failure"
            className={cn(checkStatusClassName, "dark:hidden opacity-80")}
          />
          <img
            src={checksFailureDarkIcon}
            alt="Checks failure"
            className={cn(checkStatusClassName, "hidden dark:block opacity-80")}
          />
        </>
      );
    }
    if (checksStatus === "success") {
      checkStatusIcon = (
        <>
          <img
            src={checksSuccessIcon}
            alt="Checks success"
            className={cn(checkStatusClassName, "dark:hidden opacity-80")}
          />

          <img
            src={checksSuccessDarkIcon}
            alt="Checks success"
            className={cn(checkStatusClassName, "hidden dark:block opacity-80")}
          />
        </>
      );
    }
    if (checksStatus === "pending") {
      checkStatusIcon = (
        <>
          <img
            src={checksPendingIcon}
            alt="Checks pending"
            className={cn(checkStatusClassName, "dark:hidden opacity-80")}
          />
          <img
            src={checksPendingDarkIcon}
            alt="Checks pending"
            className={cn(checkStatusClassName, "hidden dark:block opacity-80")}
          />
        </>
      );
    }
  }

  const getTitle = () => {
    switch (status) {
      case "open":
        return "Open Pull Request";
      case "closed":
        return "Closed Pull Request";
      case "merged":
        return "Merged Pull Request";
      case "draft":
        return "Draft Pull Request";
    }
  };

  return (
    <div
      title={getTitle()}
      className="flex items-center gap-1.5 cursor-pointer bg-white border border-border/40 shadow-inset-edge px-2 py-0.5 rounded-full transition-all duration-200 hover:shadow-card hover:scale-[1.02]"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        window.open(
          `https://github.com/${repoFullName}/pull/${prNumber}`,
          "_blank",
        );
      }}
    >
      <div className="flex items-center">
        {getIcon()}
        {checkStatusIcon}
      </div>
      <span className="text-[10px] font-sans font-bold text-muted-foreground/70 tracking-tight">
        #{prNumber}
      </span>
    </div>
  );
});
