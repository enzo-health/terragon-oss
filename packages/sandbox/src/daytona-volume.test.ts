import { describe, expect, it } from "vitest";
import {
  getDaytonaVolumeEnvironmentEntries,
  getDaytonaVolumeProfileContents,
  getDaytonaVolumeSetupDirs,
  resolveDaytonaVolumeLayout,
} from "./daytona-volume";

describe("resolveDaytonaVolumeLayout", () => {
  it("returns undefined when Daytona volume storage is not configured", () => {
    expect(
      resolveDaytonaVolumeLayout({
        userId: "user-1",
        environmentId: "env-1",
        threadId: "thread-1",
        repoFullName: "owner/repo",
        volumeEnabled: true,
        volumeName: "",
      }),
    ).toBeUndefined();
  });

  it("returns undefined when Daytona volume storage is not explicitly enabled", () => {
    expect(
      resolveDaytonaVolumeLayout({
        userId: "user-1",
        environmentId: "env-1",
        threadId: "thread-1",
        repoFullName: "owner/repo",
        volumeEnabled: false,
        volumeName: "terragon-workspaces",
      }),
    ).toBeUndefined();
  });

  it("builds one user-scoped mount with isolated cache and workspace paths", () => {
    expect(
      resolveDaytonaVolumeLayout({
        userId: "user/1",
        environmentId: "env:1",
        threadId: "thread 1",
        repoFullName: "owner/repo",
        volumeEnabled: true,
        volumeName: " terragon-workspaces ",
      }),
    ).toEqual({
      volumeName: "terragon-workspaces",
      volumeMountPath: "/mnt/terragon",
      volumeSubpath: "users/user_1",
      cacheMountPath: "/mnt/terragon/cache",
      workspaceMountPath:
        "/mnt/terragon/workspace/environments/env_1/repos/owner_repo/threads/thread_1",
      artifactsPath:
        "/mnt/terragon/workspace/environments/env_1/repos/owner_repo/threads/thread_1/artifacts",
    });
  });

  it("uses no-repo workspace isolation while still using volume-backed caches", () => {
    expect(
      resolveDaytonaVolumeLayout({
        userId: "user-1",
        environmentId: "env-1",
        threadId: "thread-1",
        repoFullName: null,
        volumeEnabled: true,
        volumeName: "terragon-workspaces",
      }),
    ).toMatchObject({
      workspaceMountPath:
        "/mnt/terragon/workspace/environments/env-1/repos/no-repo/threads/thread-1",
    });
  });
});

describe("Daytona volume runtime environment", () => {
  const volume = resolveDaytonaVolumeLayout({
    userId: "user-1",
    environmentId: "env-1",
    threadId: "thread-1",
    repoFullName: "owner/repo",
    volumeEnabled: true,
    volumeName: "terragon-workspaces",
  });

  it("returns cache and artifact defaults for Daytona volume sandboxes", () => {
    expect(getDaytonaVolumeEnvironmentEntries(volume)).toEqual(
      expect.arrayContaining([
        { key: "GOMODCACHE", value: "/mnt/terragon/cache/go/pkg/mod" },
        {
          key: "TERRAGON_ARTIFACTS_DIR",
          value:
            "/mnt/terragon/workspace/environments/env-1/repos/owner_repo/threads/thread-1/artifacts",
        },
        { key: "XDG_CACHE_HOME", value: "/mnt/terragon/cache/xdg" },
        { key: "COREPACK_HOME", value: "/mnt/terragon/cache/corepack" },
        { key: "TURBO_CACHE_DIR", value: "/mnt/terragon/cache/turbo" },
        {
          key: "PLAYWRIGHT_BROWSERS_PATH",
          value: "/mnt/terragon/cache/ms-playwright",
        },
        {
          key: "PUPPETEER_CACHE_DIR",
          value: "/mnt/terragon/cache/puppeteer",
        },
        {
          key: "CYPRESS_CACHE_FOLDER",
          value: "/mnt/terragon/cache/cypress",
        },
        { key: "HF_HOME", value: "/mnt/terragon/cache/huggingface" },
        {
          key: "TRANSFORMERS_CACHE",
          value: "/mnt/terragon/cache/huggingface/transformers",
        },
        {
          key: "SENTENCE_TRANSFORMERS_HOME",
          value: "/mnt/terragon/cache/huggingface/sentence-transformers",
        },
        { key: "MPLCONFIGDIR", value: "/mnt/terragon/cache/matplotlib" },
        {
          key: "ESLINT_CACHE_LOCATION",
          value: "/mnt/terragon/cache/eslint/.eslintcache",
        },
      ]),
    );
  });

  it("keeps runtime env entries and profile exports in sync", () => {
    expect(volume).toBeDefined();
    const entries = getDaytonaVolumeEnvironmentEntries(volume);
    const profileContents = getDaytonaVolumeProfileContents(volume!);

    for (const { key, value } of entries) {
      expect(profileContents).toContain(`export ${key}=${value}`);
    }
  });

  it("returns all setup directories from the same layout policy", () => {
    expect(getDaytonaVolumeSetupDirs(volume!)).toEqual(
      expect.arrayContaining([
        "/mnt/terragon/cache",
        "/mnt/terragon/cache/ms-playwright",
        "/mnt/terragon/cache/turbo",
        "/mnt/terragon/workspace/environments/env-1/repos/owner_repo/threads/thread-1",
        "/mnt/terragon/workspace/environments/env-1/repos/owner_repo/threads/thread-1/artifacts",
      ]),
    );
  });
});
