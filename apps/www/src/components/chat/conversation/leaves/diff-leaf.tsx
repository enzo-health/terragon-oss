"use client";

import {
  Diff,
  DiffContent,
  DiffFile,
  DiffFileHeader,
  DiffFileName,
  DiffFilePanel,
  DiffRow,
  DiffStat,
  type UseDiffInput,
  useDiff,
} from "@/components/ai/diff";
import type { Leaf, LeafItem } from "../leaf-props";

function diffInput(item: LeafItem<"diff">): UseDiffInput {
  if (item.unifiedDiff && item.unifiedDiff.length > 0) {
    return { patch: item.unifiedDiff, contextLines: 3 };
  }
  return { from: item.oldContent ?? "", to: item.newContent, contextLines: 3 };
}

export const DiffLeaf: Leaf<"diff"> = ({ item }) => {
  const result = useDiff(diffInput(item));
  const name = item.filePath || result.name || "File";

  return (
    <Diff>
      <DiffContent>
        <DiffFile>
          <DiffFileHeader>
            <DiffFileName>{name}</DiffFileName>
            <DiffStat kind="added">+{result.additions}</DiffStat>
            <DiffStat kind="removed">-{result.removals}</DiffStat>
          </DiffFileHeader>
          <DiffFilePanel>
            {result.lines.map((entry) => (
              <DiffRow key={entry.key} entry={entry} />
            ))}
          </DiffFilePanel>
        </DiffFile>
      </DiffContent>
    </Diff>
  );
};
