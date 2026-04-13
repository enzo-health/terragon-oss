import React from "react";
import { Box, Text } from "ink";
import { useQuery } from "@tanstack/react-query";
import packageJson from "../../package.json" assert { type: "json" };

const RELEASES_API_URL =
  "https://api.github.com/repos/terragon-labs/terragon/releases?per_page=25";

interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
}

interface GitHubRelease {
  tag_name: string;
  draft: boolean;
  prerelease: boolean;
  assets: GitHubReleaseAsset[];
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map((part) => Number.parseInt(part, 10));
  const rightParts = right.split(".").map((part) => Number.parseInt(part, 10));
  const maxLength = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < maxLength; index += 1) {
    const leftPart = leftParts[index] ?? 0;
    const rightPart = rightParts[index] ?? 0;

    if (leftPart > rightPart) {
      return 1;
    }

    if (leftPart < rightPart) {
      return -1;
    }
  }

  return 0;
}

async function checkForUpdate(): Promise<{
  current: string;
  latest: string;
} | null> {
  // Check if update notifications are disabled
  if (process.env.TERRY_NO_UPDATE_CHECK === "1") {
    return null;
  }

  const response = await fetch(RELEASES_API_URL, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "terry-cli",
    },
  });

  if (!response.ok) {
    return null;
  }

  const releases = (await response.json()) as GitHubRelease[];
  const latestRelease = releases.find((release) => {
    return (
      !release.draft &&
      !release.prerelease &&
      release.tag_name.startsWith("cli-v") &&
      release.assets.some((asset) => asset.name === "terry-cli.tar.gz")
    );
  });

  if (!latestRelease) {
    return null;
  }

  const latestVersion = latestRelease.tag_name.replace(/^cli-v/, "");

  if (compareVersions(latestVersion, packageJson.version) > 0) {
    return {
      current: packageJson.version,
      latest: latestVersion,
    };
  }

  return null;
}

export function UpdateNotifier() {
  const { data: updateInfo } = useQuery({
    queryKey: ["update-check"],
    queryFn: checkForUpdate,
    staleTime: 1000 * 60 * 60, // 1 hour
    retry: false, // Don't retry update checks
  });

  if (!updateInfo) {
    return null;
  }

  return (
    <Box marginBottom={1} borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow">
        Update available: {updateInfo.current} → {updateInfo.latest}
      </Text>
      <Text color="gray"> Run </Text>
      <Text color="cyan">
        curl -fsSL https://terragon-lake.vercel.app/install-terry.sh | bash
      </Text>
      <Text color="gray"> to update</Text>
    </Box>
  );
}
