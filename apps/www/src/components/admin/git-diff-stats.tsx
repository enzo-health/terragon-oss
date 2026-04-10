import { Thread } from "@leo/shared";

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
        <span className="text-green-600 text-xs font-medium">
          +{diffStats.additions}
        </span>
      )}
      {diffStats.deletions > 0 && (
        <span className="text-red-600 text-xs font-medium">
          -{diffStats.deletions}
        </span>
      )}
    </div>
  );
}
