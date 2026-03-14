import { cn } from "@/lib/utils";
import { GithubCheckStatus, GithubPRStatus } from "@terragon/shared";
import {
  GitPullRequestArrow,
  GitMerge,
  GitPullRequestClosed,
  GitPullRequestDraft,
} from "lucide-react";

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

export const PRStatusPill = ({
  status,
  checksStatus,
  prNumber,
  repoFullName,
}: {
  status: GithubPRStatus;
  checksStatus: GithubCheckStatus | null;
  prNumber: number;
  repoFullName: string;
}) => {
  const iconClassName = "size-4 mr-1";
  const getIcon = () => {
    switch (status) {
      case "open":
        return (
          <GitPullRequestArrow
            className={cn(iconClassName, "shrink-0 text-[#238636]")}
          />
        );
      case "closed":
        return (
          <GitPullRequestClosed
            className={cn(iconClassName, "shrink-0 text-[#da3633]")}
          />
        );
      case "merged":
        return (
          <GitMerge className={cn(iconClassName, "shrink-0 text-[#8957e5]")} />
        );
      case "draft":
        return (
          <GitPullRequestDraft
            className={cn(iconClassName, "shrink-0 text-[#656c76]")}
          />
        );
    }
  };

  const checkStatusClassName = "size-4";
  let checkStatusIcon = null;
  if (status === "open" || status === "draft") {
    if (checksStatus === "failure") {
      checkStatusIcon = (
        <>
          <img
            src={checksFailureIcon}
            alt="Checks failure"
            className={cn(checkStatusClassName, "dark:hidden")}
          />
          <img
            src={checksFailureDarkIcon}
            alt="Checks failure"
            className={cn(checkStatusClassName, "hidden dark:block")}
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
            className={cn(checkStatusClassName, "dark:hidden")}
          />

          <img
            src={checksSuccessDarkIcon}
            alt="Checks success"
            className={cn(checkStatusClassName, "hidden dark:block")}
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
            className={cn(checkStatusClassName, "dark:hidden")}
          />
          <img
            src={checksPendingDarkIcon}
            alt="Checks pending"
            className={cn(checkStatusClassName, "hidden dark:block")}
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
      className="flex items-center gap-1 cursor-pointer"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        window.open(
          `https://github.com/${repoFullName}/pull/${prNumber}`,
          "_blank",
        );
      }}
    >
      {getIcon()}
      {checkStatusIcon}
    </div>
  );
};
