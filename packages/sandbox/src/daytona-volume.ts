import path from "node:path";

const DAYTONA_VOLUME_MOUNT_PATH = "/mnt/terragon";
const DAYTONA_VOLUME_CACHE_DIR = "cache";
const DAYTONA_VOLUME_WORKSPACE_DIR = "workspace";
export const DAYTONA_VOLUME_PROFILE_PATH =
  "/etc/profile.d/00-terragon-volume.sh";
export const DAYTONA_VOLUME_ARTIFACTS_DIR = "artifacts";
const DAYTONA_VOLUME_PNPM_STORE_DIR = "pnpm/store";
const DAYTONA_VOLUME_NEXT_CACHE_DIR = "next-cache";

const DAYTONA_VOLUME_CACHE_DIRS = [
  "npm",
  "yarn",
  "bun",
  DAYTONA_VOLUME_PNPM_STORE_DIR,
  "pip",
  "uv",
  "cargo",
  "go/pkg/mod",
  "go/build",
  "composer",
  "xdg",
  "corepack",
  "turbo",
  "ms-playwright",
  "puppeteer",
  "cypress",
  "huggingface/transformers",
  "huggingface/sentence-transformers",
  "matplotlib",
  "eslint",
] as const;

export type DaytonaVolumeLayout = {
  volumeName: string;
  volumeMountPath: string;
  volumeSubpath: string;
  cacheMountPath: string;
  repoCacheMountPath: string;
  workspaceMountPath: string;
  artifactsPath: string;
  pnpmStorePath: string;
  pnpmVirtualStorePath: string;
  nextCachePath: string;
};

export type DaytonaVolumeConfig = DaytonaVolumeLayout;

function sanitizeVolumeSubpathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function resolveDaytonaVolumeLayout({
  userId,
  environmentId,
  threadId,
  repoFullName,
  volumeEnabled,
  volumeName,
}: {
  userId: string;
  environmentId: string;
  threadId: string;
  repoFullName: string | null;
  volumeEnabled: boolean;
  volumeName: string;
}): DaytonaVolumeLayout | undefined {
  if (!volumeEnabled) {
    return undefined;
  }

  const trimmedVolumeName = volumeName.trim();
  if (!trimmedVolumeName) {
    return undefined;
  }

  const repoSegment = sanitizeVolumeSubpathSegment(repoFullName || "no-repo");
  const userSegment = sanitizeVolumeSubpathSegment(userId);
  const workspaceSegments = [
    DAYTONA_VOLUME_WORKSPACE_DIR,
    "environments",
    sanitizeVolumeSubpathSegment(environmentId),
    "repos",
    repoSegment,
    "threads",
    sanitizeVolumeSubpathSegment(threadId),
  ];
  const workspaceMountPath = [
    DAYTONA_VOLUME_MOUNT_PATH,
    ...workspaceSegments,
  ].join("/");
  const repoCacheMountPath = [
    DAYTONA_VOLUME_MOUNT_PATH,
    DAYTONA_VOLUME_CACHE_DIR,
    "environments",
    sanitizeVolumeSubpathSegment(environmentId),
    "repos",
    repoSegment,
  ].join("/");

  return {
    volumeName: trimmedVolumeName,
    volumeMountPath: DAYTONA_VOLUME_MOUNT_PATH,
    volumeSubpath: `users/${userSegment}`,
    cacheMountPath: [DAYTONA_VOLUME_MOUNT_PATH, DAYTONA_VOLUME_CACHE_DIR].join(
      "/",
    ),
    repoCacheMountPath,
    workspaceMountPath,
    artifactsPath: path.posix.join(
      workspaceMountPath,
      DAYTONA_VOLUME_ARTIFACTS_DIR,
    ),
    pnpmStorePath: path.posix.join(
      DAYTONA_VOLUME_MOUNT_PATH,
      DAYTONA_VOLUME_CACHE_DIR,
      DAYTONA_VOLUME_PNPM_STORE_DIR,
    ),
    pnpmVirtualStorePath: path.posix.join(
      workspaceMountPath,
      "node_modules/.pnpm",
    ),
    nextCachePath: path.posix.join(
      repoCacheMountPath,
      DAYTONA_VOLUME_NEXT_CACHE_DIR,
    ),
  };
}

export function getDaytonaVolumeEnvironmentEntries(
  volume: DaytonaVolumeLayout | undefined,
): Array<{ key: string; value: string }> {
  if (!volume) {
    return [];
  }
  return [
    { key: "npm_config_cache", value: `${volume.cacheMountPath}/npm` },
    { key: "YARN_CACHE_FOLDER", value: `${volume.cacheMountPath}/yarn` },
    { key: "BUN_INSTALL_CACHE_DIR", value: `${volume.cacheMountPath}/bun` },
    { key: "PNPM_STORE_DIR", value: volume.pnpmStorePath },
    { key: "pnpm_config_store_dir", value: volume.pnpmStorePath },
    {
      key: "pnpm_config_virtual_store_dir",
      value: volume.pnpmVirtualStorePath,
    },
    { key: "PIP_CACHE_DIR", value: `${volume.cacheMountPath}/pip` },
    { key: "UV_CACHE_DIR", value: `${volume.cacheMountPath}/uv` },
    { key: "CARGO_HOME", value: `${volume.cacheMountPath}/cargo` },
    { key: "GOPATH", value: `${volume.cacheMountPath}/go` },
    { key: "GOMODCACHE", value: `${volume.cacheMountPath}/go/pkg/mod` },
    { key: "GOCACHE", value: `${volume.cacheMountPath}/go/build` },
    { key: "COMPOSER_CACHE_DIR", value: `${volume.cacheMountPath}/composer` },
    { key: "XDG_CACHE_HOME", value: `${volume.cacheMountPath}/xdg` },
    { key: "COREPACK_HOME", value: `${volume.cacheMountPath}/corepack` },
    { key: "TURBO_CACHE_DIR", value: `${volume.cacheMountPath}/turbo` },
    {
      key: "PLAYWRIGHT_BROWSERS_PATH",
      value: `${volume.cacheMountPath}/ms-playwright`,
    },
    { key: "PUPPETEER_CACHE_DIR", value: `${volume.cacheMountPath}/puppeteer` },
    { key: "CYPRESS_CACHE_FOLDER", value: `${volume.cacheMountPath}/cypress` },
    { key: "HF_HOME", value: `${volume.cacheMountPath}/huggingface` },
    {
      key: "TRANSFORMERS_CACHE",
      value: `${volume.cacheMountPath}/huggingface/transformers`,
    },
    {
      key: "SENTENCE_TRANSFORMERS_HOME",
      value: `${volume.cacheMountPath}/huggingface/sentence-transformers`,
    },
    { key: "MPLCONFIGDIR", value: `${volume.cacheMountPath}/matplotlib` },
    {
      key: "ESLINT_CACHE_LOCATION",
      value: `${volume.cacheMountPath}/eslint/.eslintcache`,
    },
    { key: "TERRAGON_VOLUME_CACHE_DIR", value: volume.cacheMountPath },
    { key: "TERRAGON_VOLUME_WORKSPACE_DIR", value: volume.workspaceMountPath },
    { key: "TERRAGON_PNPM_STORE_DIR", value: volume.pnpmStorePath },
    {
      key: "TERRAGON_PNPM_VIRTUAL_STORE_DIR",
      value: volume.pnpmVirtualStorePath,
    },
    { key: "TERRAGON_ARTIFACTS_DIR", value: volume.artifactsPath },
  ];
}

export function getDaytonaVolumeSetupDirs(
  volume: DaytonaVolumeLayout,
): string[] {
  return [
    volume.cacheMountPath,
    volume.workspaceMountPath,
    ...DAYTONA_VOLUME_CACHE_DIRS.map((dir) =>
      path.posix.join(volume.cacheMountPath, dir),
    ),
    volume.artifactsPath,
    volume.pnpmStorePath,
    volume.pnpmVirtualStorePath,
    volume.nextCachePath,
  ];
}

export function getDaytonaVolumeProfileContents(
  volume: DaytonaVolumeLayout,
): string {
  return getDaytonaVolumeEnvironmentEntries(volume)
    .map(({ key, value }) => `export ${key}=${value}`)
    .join("\n");
}
