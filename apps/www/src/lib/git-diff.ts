export type FileChangeType = "added" | "deleted" | "modified";

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "ico",
  "bmp",
  "tiff",
  "tif",
  "avif",
]);

export function isImageFile(fileName: string): boolean {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  return IMAGE_EXTENSIONS.has(ext);
}

export interface ParsedDiffFile {
  fullDiff: string;
  fileName: string;
  fileLang: string;
  additions: number;
  deletions: number;
  changeType: FileChangeType;
  isBinary: boolean;
  isImage: boolean;
  oldFileSize?: number; // Size in bytes (for binary files)
  newFileSize?: number; // Size in bytes (for binary files)
}

interface BinaryFileInfo {
  oldSize: number;
  newSize: number;
}

/**
 * Parses binary file sizes from git diff --stat summary section
 * Format: " path/to/file.png | Bin 0 -> 3995 bytes"
 */
function parseBinaryFileSizes(diffString: string): Map<string, BinaryFileInfo> {
  const binaryFiles = new Map<string, BinaryFileInfo>();
  const lines = diffString.split("\n");

  // Parse the stat summary section (before the first "diff --git")
  for (const line of lines) {
    if (line.startsWith("diff --git")) break;

    // Match: " path/to/file.png | Bin 0 -> 3995 bytes"
    const match = line.match(
      /^\s*(.+?)\s+\|\s+Bin\s+(\d+)\s+->\s+(\d+)\s+bytes/,
    );
    if (match) {
      const [, filePath, oldSize, newSize] = match;
      if (!filePath || !oldSize || !newSize) continue;
      binaryFiles.set(filePath.trim(), {
        oldSize: parseInt(oldSize, 10),
        newSize: parseInt(newSize, 10),
      });
    }
  }

  return binaryFiles;
}

/**
 * Parses a multi-file git diff string into individual file diffs
 * @param diffString - The complete git diff output containing one or more file diffs
 * @returns Array of parsed diff files with metadata
 */
export function parseMultiFileDiff(diffString: string): ParsedDiffFile[] {
  const files: ParsedDiffFile[] = [];

  // Parse binary file sizes once from the stat summary
  const binaryFilesMap = parseBinaryFileSizes(diffString);

  // Split by "diff --git" to separate files
  const fileDiffs = diffString.split(/^diff --git /m).filter(Boolean);

  for (const fileDiff of fileDiffs) {
    try {
      // Extract file paths from the first line (e.g., "a/path/file.ts b/path/file.ts")
      const firstLine = fileDiff.split("\n")[0];
      if (!firstLine) continue;

      // Match file paths, handling spaces in filenames
      // We need to find where " b/" or "\tb/" appears to split the paths correctly
      // Using a regex that matches " b/" or "\tb/" as the separator
      const separatorMatch = firstLine.match(/[\s\t]b\//);
      if (!separatorMatch || separatorMatch.index === undefined) continue;

      const beforeSeparator = firstLine.substring(0, separatorMatch.index);
      const afterSeparator = firstLine.substring(
        separatorMatch.index + separatorMatch[0].length,
      );

      // Extract the file path after "a/"
      const oldPath = beforeSeparator.match(/a\/(.+)$/)?.[1];
      if (!oldPath) continue;

      const fileName = afterSeparator.trim(); // The new file path
      if (!fileName) continue;

      // Extract language from file extension
      const langMatch = fileName.match(/\.([^.]+)$/);
      const fileLang = langMatch?.[1] || "txt";

      // Reconstruct the full diff for this file (include the "diff --git" line)
      const fullDiff = `diff --git ${fileDiff}`;

      // Count additions and deletions, and determine change type
      const lines = fullDiff.split("\n");
      let additions = 0;
      let deletions = 0;
      let isNewFile = false;
      let isDeletedFile = false;
      let isBinary = false;

      for (const line of lines) {
        if (line.startsWith("new file mode")) {
          isNewFile = true;
        } else if (line.startsWith("deleted file mode")) {
          isDeletedFile = true;
        } else if (
          line.startsWith("Binary files") ||
          line.includes("Binary files")
        ) {
          isBinary = true;
        } else if (line.startsWith("+") && !line.startsWith("+++")) {
          additions++;
        } else if (line.startsWith("-") && !line.startsWith("---")) {
          deletions++;
        }
      }

      // Get file sizes from the pre-parsed binary files map
      const binaryInfo = binaryFilesMap.get(fileName);
      const oldFileSize = binaryInfo?.oldSize;
      const newFileSize = binaryInfo?.newSize;

      // Determine change type
      let changeType: FileChangeType;
      if (isNewFile) {
        changeType = "added";
      } else if (isDeletedFile) {
        changeType = "deleted";
      } else {
        changeType = "modified";
      }

      const isImage = isImageFile(fileName);

      files.push({
        fullDiff,
        fileName,
        fileLang,
        additions,
        deletions,
        changeType,
        isBinary,
        isImage,
        oldFileSize,
        newFileSize,
      });
    } catch (e) {
      console.error("Failed to parse file diff:", e);
    }
  }

  return files;
}
