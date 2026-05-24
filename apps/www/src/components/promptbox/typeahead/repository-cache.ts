import type { TreeFile } from "@/lib/github-tree";
import { fetchRepositoryFiles } from "@/server-actions/github-tree-search";
import { unwrapResult } from "@/lib/server-actions";
import { searchFilesLocally } from "@/lib/file-search";
import { Typeahead } from "./typeahead";
import { useEffect, useState } from "react";

export class RepositoryCache implements Typeahead {
  private cache = new Map<string, { files: TreeFile[]; timestamp: number }>();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  private selectedRepo: string | null = null;
  private selectedBranch: string | null = null;
  private fetchResultByCacheKey: Record<
    string,
    ReturnType<typeof fetchRepositoryFiles>
  > = {};

  constructor() {}

  setSelectedRepo(repoFullName: string | null, branchName: string | null) {
    this.selectedRepo = repoFullName;
    this.selectedBranch = branchName;
  }

  getSelectedRepo() {
    return {
      repoFullName: this.selectedRepo,
      branchName: this.selectedBranch,
    };
  }

  private getCacheKey(repoFullName: string, branchName: string): string {
    return `${repoFullName}:${branchName}`;
  }

  private clearStaleCache() {
    const now = Date.now();
    for (const [key, value] of this.cache.entries()) {
      if (now - value.timestamp > this.CACHE_TTL) {
        delete this.fetchResultByCacheKey[key];
        this.cache.delete(key);
      }
    }
  }

  private async fetchRepositoryFiles({
    repoFullName,
    branchName,
  }: {
    repoFullName: string;
    branchName: string;
  }) {
    const cacheKey = this.getCacheKey(repoFullName, branchName);
    if (!this.fetchResultByCacheKey[cacheKey]) {
      this.fetchResultByCacheKey[cacheKey] = fetchRepositoryFiles({
        repoFullName,
        branchName,
      });
    }
    return this.fetchResultByCacheKey[cacheKey];
  }

  async getSuggestions(
    query: string,
  ): Promise<{ name: string; type?: "blob" | "tree" }[]> {
    const { repoFullName, branchName } = this.getSelectedRepo();

    if (!repoFullName || !branchName) {
      return [];
    }

    await this.ensureRepositoryFiles();

    const cacheKey = this.getCacheKey(repoFullName, branchName);
    const cached = this.cache.get(cacheKey);

    if (!cached || !cached.files.length) {
      return [];
    }

    try {
      const results = searchFilesLocally(cached.files, query);
      return results.slice(0, 20).map((file) => ({
        name: file.type === "tree" ? `${file.path}/` : file.path,
        type: file.type,
      })); // Limit results for performance
    } catch (error) {
      console.error("Failed to search files:", error);
      return [];
    }
  }

  async ensureRepositoryFiles(): Promise<boolean> {
    const { repoFullName, branchName } = this.getSelectedRepo();

    if (!repoFullName || !branchName) {
      return false;
    }

    const cacheKey = this.getCacheKey(repoFullName, branchName);
    const cached = this.cache.get(cacheKey);
    const now = Date.now();

    // Periodically clear stale cache entries
    if (Math.random() < 0.1) {
      // 10% chance to clean up on each check
      this.clearStaleCache();
    }

    // Check if cache is valid
    const isCacheValid = cached && now - cached.timestamp < this.CACHE_TTL;

    if (!isCacheValid) {
      try {
        const files = unwrapResult(
          await this.fetchRepositoryFiles({
            repoFullName,
            branchName,
          }),
        );

        this.cache.set(cacheKey, {
          files,
          timestamp: now,
        });

        return true;
      } catch (error) {
        console.error("Failed to fetch repository files:", error);
        return false;
      }
    }

    return true;
  }

  clearCache() {
    this.cache.clear();
  }
}

export function useRepositoryCache({
  repoFullName,
  branchName,
}: {
  repoFullName: string;
  branchName: string;
}) {
  const [repositoryCache] = useState(() => new RepositoryCache());
  useEffect(() => {
    repositoryCache.setSelectedRepo(repoFullName, branchName);
  }, [repositoryCache, repoFullName, branchName]);
  return repositoryCache;
}
