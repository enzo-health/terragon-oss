import { describe, it, vi, beforeEach, expect } from "vitest";
import { getRepoTreeAction as serverAction } from "./get-repo-tree";
import { db } from "@/lib/db";
import {
  createTestUser,
  createTestThread,
} from "@terragon/shared/model/test-helpers";
import { mockLoggedInUser, mockLoggedOutUser } from "@/test-helpers/mock-next";
import { User, Session } from "@terragon/shared";
import { getOctokitForUser, getOctokitForUserOrThrow } from "@/lib/github";
import { upsertFeatureFlag } from "@terragon/shared/model/feature-flags";
import { unwrapResult } from "@/lib/server-actions";

vi.mock("@/lib/github", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    getOctokitForUser: vi.fn(),
    getOctokitForUserOrThrow: vi.fn(),
  };
});

const callAction = async (args: { threadId: string }) =>
  unwrapResult(await serverAction(args));

function makeOctokit(getTree: ReturnType<typeof vi.fn>) {
  return {
    rest: {
      git: { getTree },
      repos: {
        get: vi.fn().mockResolvedValue({
          data: { permissions: { admin: true, push: true, pull: true } },
        }),
      },
    },
  };
}

function treeResponse(
  tree: Array<{ path: string; type: string }>,
  truncated = false,
) {
  return { data: { tree, truncated } };
}

describe("getRepoTreeAction", () => {
  let user: User;
  let session: Session;
  let otherSession: Session;
  let threadId: string;
  let getTree: ReturnType<typeof vi.fn>;

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

    await upsertFeatureFlag({
      db,
      name: "repoFilePreview",
      updates: { defaultValue: false, globalOverride: true },
    });

    getTree = vi.fn().mockResolvedValue(
      treeResponse([
        { path: "src", type: "tree" },
        { path: "src/index.ts", type: "blob" },
        { path: "README.md", type: "blob" },
        { path: "vendor", type: "commit" },
      ]),
    );
    vi.mocked(getOctokitForUserOrThrow).mockResolvedValue(
      makeOctokit(getTree) as never,
    );
    vi.mocked(getOctokitForUser).mockResolvedValue(
      makeOctokit(getTree) as never,
    );

    await mockLoggedInUser(session);
  });

  it("returns only blob paths for an authorized owner", async () => {
    const result = await callAction({ threadId });
    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.paths).toEqual(["src/index.ts", "README.md"]);
      expect(result.truncated).toBe(false);
    }
  });

  it("reads the recursive tree at the working branch ref", async () => {
    await callAction({ threadId });
    expect(getTree).toHaveBeenCalledWith(
      expect.objectContaining({
        tree_sha: "feature/working-branch",
        recursive: "1",
      }),
    );
  });

  it("falls back to the base branch when the working branch 404s", async () => {
    getTree
      .mockRejectedValueOnce({ status: 404 })
      .mockResolvedValueOnce(treeResponse([{ path: "base.ts", type: "blob" }]));
    const result = await callAction({ threadId });
    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.paths).toEqual(["base.ts"]);
      expect(result.ref).toBe("main");
    }
    expect(getTree).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ tree_sha: "main" }),
    );
  });

  it("surfaces GitHub's truncation flag", async () => {
    getTree.mockResolvedValue(
      treeResponse([{ path: "a.ts", type: "blob" }], true),
    );
    const result = await callAction({ threadId });
    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.truncated).toBe(true);
    }
  });

  it("maps a 404 on both refs to not-found", async () => {
    getTree.mockRejectedValue({ status: 404 });
    const result = await callAction({ threadId });
    expect(result).toEqual({ status: "error", category: "not-found" });
    expect(getTree).toHaveBeenCalledTimes(2);
  });

  it("does not retry base on a non-404 error", async () => {
    getTree.mockRejectedValue({ status: 500 });
    const result = await callAction({ threadId });
    expect(result).toEqual({ status: "error", category: "github-error" });
    expect(getTree).toHaveBeenCalledTimes(1);
  });

  it("denies a non-owner of a private thread", async () => {
    await mockLoggedInUser(otherSession);
    const result = await callAction({ threadId });
    expect(result).toEqual({ status: "error", category: "unauthorized" });
    expect(getTree).not.toHaveBeenCalled();
  });

  it("denies an unauthenticated user", async () => {
    await mockLoggedOutUser();
    await expect(callAction({ threadId })).rejects.toThrow("Unauthorized");
  });

  it("returns feature-disabled when the flag is off", async () => {
    await upsertFeatureFlag({
      db,
      name: "repoFilePreview",
      updates: { defaultValue: false, globalOverride: false },
    });
    const result = await callAction({ threadId });
    expect(result).toEqual({ status: "error", category: "feature-disabled" });
    expect(getTree).not.toHaveBeenCalled();
  });
});
