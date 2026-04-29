import { Thread } from "@terragon/shared";

export function GitDiffStats({
  diffStats,
}: {
  diffStats: Thread["gitDiffStats"];
}) {
  if (!diffStats) {
    return null;
  }
  return (
    <div className="flex items-center gap-1">
      {diffStats.additions > 0 && (
        <span className="text-[var(--diff-added-fg)] text-xs font-medium">
          +{diffStats.additions}
        </span>
      )}
      {diffStats.deletions > 0 && (
        <span className="text-[var(--diff-removed-fg)] text-xs font-medium">
          -{diffStats.deletions}
        </span>
      )}
    </div>
  );
}
