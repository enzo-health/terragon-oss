import { beforeEach, describe, expect, it, vi } from "vitest";

type ImageContext = {
  sourcePath: string;
  archivePath: string;
};

const mockState = vi.hoisted(() => {
  const daytonaSnapshotCreate = vi.fn();
  const imageFromDockerfile = vi.fn();
  const imageAddLocalFile = vi.fn();
  const createdImages: Array<{
    dockerfile: string;
    contextList: ImageContext[];
  }> = [];

  class MockImage {
    dockerfile = "";
    contextList: ImageContext[] = [];

    static base(image: string): MockImage {
      const mockImage = new MockImage();
      mockImage.dockerfile = `FROM ${image}\n`;
      createdImages.push(mockImage);
      return mockImage;
    }

    static fromDockerfile(path: string): MockImage {
      imageFromDockerfile(path);
      throw new Error("Image.fromDockerfile should not be used");
    }

    dockerfileCommands(commands: string[]): MockImage {
      this.dockerfile += `${commands.join("\n")}\n`;
      return this;
    }

    env(envVars: Record<string, string>): MockImage {
      for (const [key, value] of Object.entries(envVars)) {
        this.dockerfile += `ENV ${key}=${value}\n`;
      }
      return this;
    }

    runCommands(...commands: string[]): MockImage {
      for (const command of commands) {
        this.dockerfile += `RUN ${command}\n`;
      }
      return this;
    }

    addLocalFile(localPath: string, remotePath: string): MockImage {
      imageAddLocalFile(localPath, remotePath);
      throw new Error("Image.addLocalFile should not be used");
    }
  }

  return {
    daytonaSnapshotCreate,
    imageFromDockerfile,
    imageAddLocalFile,
    createdImages,
    MockImage,
  };
});

vi.mock("@daytonaio/sdk", () => {
  class MockDaytona {
    snapshot = {
      create: mockState.daytonaSnapshotCreate,
      delete: vi.fn(),
      get: vi.fn(),
      list: vi.fn(),
    };
  }

  return {
    Daytona: MockDaytona,
    Image: mockState.MockImage,
  };
});

import { buildRepoSnapshot } from "./snapshot-builder";

describe("buildRepoSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("DAYTONA_API_KEY", "daytona-api-key");
    mockState.createdImages.length = 0;
    mockState.daytonaSnapshotCreate.mockResolvedValue(undefined);
  });

  it("builds declarative images without SDK local file helpers", async () => {
    await buildRepoSnapshot({
      repoFullName: "owner/repo",
      baseBranch: "main",
      githubAccessToken: "github-token",
      setupScript: "printf 'hello from setup\\n'",
      environmentVariables: [{ key: "EXAMPLE", value: "value" }],
      size: "small",
    });

    expect(mockState.imageFromDockerfile).not.toHaveBeenCalled();
    expect(mockState.imageAddLocalFile).not.toHaveBeenCalled();
    expect(mockState.createdImages).toHaveLength(1);
    expect(mockState.createdImages[0]!.contextList).toEqual([]);
    expect(mockState.createdImages[0]!.dockerfile).toContain(
      "FROM ubuntu:24.04",
    );
    expect(mockState.createdImages[0]!.dockerfile).not.toContain(
      "COPY supervisord.conf",
    );
    expect(mockState.createdImages[0]!.dockerfile).not.toContain("RUN RUN ");
    expect(mockState.createdImages[0]!.dockerfile).toContain(
      "/etc/supervisor/conf.d/supervisord.conf",
    );
    expect(mockState.createdImages[0]!.dockerfile).toContain(
      "/tmp/terragon-setup.sh",
    );
    expect(mockState.daytonaSnapshotCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        image: mockState.createdImages[0],
        name: expect.stringMatching(/^repo-owner-repo-small-/),
      }),
      { onLogs: undefined, timeout: 0 },
    );
  });
});
