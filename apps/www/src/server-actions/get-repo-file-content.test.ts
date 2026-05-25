import { describe, it, vi, beforeEach, expect } from "vitest";
import { getRepoFileContentAction as serverAction } from "./get-repo-file-content";
import { db } from "@/lib/db";
import {
  createTestUser,
  createTestThread,
} from "@terragon/shared/model/test-helpers";
import { mockLoggedInUser, mockLoggedOutUser } from "@/test-helpers/mock-next";
import { User, Session } from "@terragon/shared";
import { getOctokitForUser, getOctokitForUserOrThrow } from "@/lib/github";
import { upsertFeatureFlag } from "@terragon/shared/model/feature-flags";
import { updateThreadVisibility } from "@terragon/shared/model/thread-visibility";
import { unwrapResult } from "@/lib/server-actions";

vi.mock("@/lib/github", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getOctokitForUser: vi.fn(),
    getOctokitForUserOrThrow: vi.fn(),
  };
});

const callAction = async (args: { threadId: string; path: string }) =>
  unwrapResult(await serverAction(args));

function makeOctokit(getContent: ReturnType<typeof vi.fn>) {
  return {
    rest: {
      repos: {
        getContent,
        // Permission check used for repo-visibility threads.
        get: vi.fn().mockResolvedValue({
          data: { permissions: { admin: true, push: true, pull: true } },
        }),
      },
    },
  };
}

function blobResponse(content: string) {
  return {
    data: {
      content: Buffer.from(content, "utf8").toString("base64"),
      encoding: "base64",
    },
  };
}

describe("getRepoFileContentAction", () => {
  let user: User;
  let session: Session;
  let otherSession: Session;
  let threadId: string;
  let getContent: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();

    const [owner, other] = await Promise.all([
      createTestUser({ db }),
      createTestUser({ db }),
    ]);
    user = owner.user;
    session = owner.session;
    otherSession = other.session;

    const created = await createTestThread({
      db,
      userId: user.id,
      overrides: { branchName: "feature/working-branch" },
    });
    threadId = created.threadId;

    // Flag must be on for content to load.
    await upsertFeatureFlag({
      db,
      name: "repoFilePreview",
      updates: { defaultValue: false, globalOverride: true },
    });

    getContent = vi
      .fn()
      .mockResolvedValue(blobResponse("export const x = 1;\n"));
    vi.mocked(getOctokitForUserOrThrow).mockResolvedValue(
      makeOctokit(getContent) as never,
    );
    vi.mocked(getOctokitForUser).mockResolvedValue(
      makeOctokit(getContent) as never,
    );

    await mockLoggedInUser(session);
  });

  it("returns file content for an authorized owner", async () => {
    const result = await callAction({ threadId, path: "src/foo.ts" });
    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.content).toBe("export const x = 1;\n");
      expect(result.path).toBe("src/foo.ts");
    }
  });

  it("uses the working branchName as the getContent ref when present", async () => {
    await callAction({ threadId, path: "src/foo.ts" });
    expect(getContent).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "feature/working-branch" }),
    );
  });

  it("falls back to repoBaseBranchName when branchName is null", async () => {
    const baseOnly = await createTestThread({
      db,
      userId: user.id,
      overrides: { branchName: null, repoBaseBranchName: "main" },
    });
    await callAction({ threadId: baseOnly.threadId, path: "src/foo.ts" });
    expect(getContent).toHaveBeenCalledWith(
      expect.objectContaining({ ref: "main" }),
    );
  });

  it("denies a non-owner of a private thread (authz)", async () => {
    await mockLoggedInUser(otherSession);
    const result = await callAction({ threadId, path: "src/foo.ts" });
    expect(result).toEqual({ status: "error", category: "unauthorized" });
    expect(getContent).not.toHaveBeenCalled();
  });

  it("denies an unauthenticated user", async () => {
    await mockLoggedOutUser();
    await expect(callAction({ threadId, path: "src/foo.ts" })).rejects.toThrow(
      "Unauthorized",
    );
  });

  it("rejects path traversal before any GitHub fetch", async () => {
    const result = await callAction({ threadId, path: "../../etc/passwd" });
    expect(result).toEqual({ status: "error", category: "invalid-path" });
    expect(getContent).not.toHaveBeenCalled();
  });

  it("returns no content when the flag is off", async () => {
    await upsertFeatureFlag({
      db,
      name: "repoFilePreview",
      updates: { defaultValue: false, globalOverride: false },
    });
    const result = await callAction({ threadId, path: "src/foo.ts" });
    expect(result).toEqual({ status: "error", category: "feature-disabled" });
    expect(getContent).not.toHaveBeenCalled();
  });

  it("maps a 404 (unpushed/missing file) to a typed not-found error", async () => {
    getContent.mockRejectedValue({ status: 404 });
    const result = await callAction({
      threadId,
      path: "src/never-pushed.ts",
    });
    expect(result).toEqual({ status: "error", category: "not-found" });
  });

  it("authorizes a repo-visibility thread for a user with repo access", async () => {
    await updateThreadVisibility({
      db,
      userId: user.id,
      threadId,
      visibility: "repo",
    });
    await mockLoggedInUser(otherSession);
    const result = await callAction({ threadId, path: "src/foo.ts" });
    expect(result.status).toBe("ready");
  });
});
