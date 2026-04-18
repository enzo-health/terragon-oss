import { describe, expect, it } from "vitest";
import { env } from "@terragon/env/pkg-shared";
import { createDb } from "../db";
import * as schema from "../db/schema";
import {
  getGithubPrProjectionByRepoIdAndNumber,
  upsertGithubInstallationProjection,
  upsertGithubPrProjection,
  upsertGithubRepoProjection,
} from "./github-projections";

const db = createDb(env.DATABASE_URL!);

let nextGithubIdValue = 1_000_000_000;

function nextGithubId(): number {
  nextGithubIdValue += 1;
  return nextGithubIdValue;
}

describe("github projection helpers", () => {
  it("resolves parent projections from GitHub IDs and normalizes draft state", async () => {
    const installationId = nextGithubId();
    const repoId = nextGithubId();
    const prNodeId = `PR_${repoId}`;

    const installationProjection = await upsertGithubInstallationProjection({
      db,
      installationId,
      fields: {
        targetAccountLogin: `terragon-${installationId}`,
        targetAccountType: "Organization",
      },
    });

    const repoProjection = await upsertGithubRepoProjection({
      db,
      installationId,
      repoId,
      fields: {
        currentSlug: `terragon/test-repo-${repoId}`,
      },
    });

    expect(repoProjection.installationProjectionId).toBe(
      installationProjection.id,
    );
    expect(repoProjection.installationId).toBe(installationId);

    const draftProjection = await upsertGithubPrProjection({
      db,
      prNodeId,
      repoId,
      fields: {
        number: 17,
        status: "draft",
        baseRef: "main",
        headRef: "feature/projections",
        headSha: "abc123",
      },
    });

    expect(draftProjection.repoProjectionId).toBe(repoProjection.id);
    expect(draftProjection.repoId).toBe(repoId);
    expect(draftProjection.isDraft).toBe(true);

    const openProjection = await upsertGithubPrProjection({
      db,
      prNodeId,
      repoId,
      fields: {
        number: 17,
        status: "open",
        baseRef: "main",
        headRef: "feature/projections",
        headSha: "def456",
      },
    });

    expect(openProjection.isDraft).toBe(false);

    const lookedUpProjection = await getGithubPrProjectionByRepoIdAndNumber({
      db,
      repoId,
      number: 17,
    });

    expect(lookedUpProjection?.id).toBe(openProjection.id);
    expect(lookedUpProjection?.prNodeId).toBe(prNodeId);
  });

  it("rejects rebinding an existing PR node id to a different repo or number", async () => {
    const installationId = nextGithubId();
    const repoId = nextGithubId();
    const otherRepoId = nextGithubId();
    const prNodeId = `PR_${repoId}_identity`;

    await upsertGithubInstallationProjection({
      db,
      installationId,
      fields: {
        targetAccountLogin: `terragon-${installationId}`,
        targetAccountType: "Organization",
      },
    });

    await upsertGithubRepoProjection({
      db,
      installationId,
      repoId,
      fields: {
        currentSlug: `terragon/test-repo-${repoId}`,
      },
    });

    await upsertGithubRepoProjection({
      db,
      installationId,
      repoId: otherRepoId,
      fields: {
        currentSlug: `terragon/test-repo-${otherRepoId}`,
      },
    });

    await upsertGithubPrProjection({
      db,
      prNodeId,
      repoId,
      fields: {
        number: 23,
        status: "open",
      },
    });

    await expect(
      upsertGithubPrProjection({
        db,
        prNodeId,
        repoId: otherRepoId,
        fields: {
          number: 23,
          status: "open",
        },
      }),
    ).rejects.toThrow("identity mismatch");

    await expect(
      upsertGithubPrProjection({
        db,
        prNodeId,
        repoId,
        fields: {
          number: 24,
          status: "open",
        },
      }),
    ).rejects.toThrow("identity mismatch");
  });

  it("rejects inconsistent draft state at the database layer", async () => {
    const installationId = nextGithubId();
    const repoId = nextGithubId();

    await upsertGithubInstallationProjection({
      db,
      installationId,
      fields: {
        targetAccountLogin: `terragon-${installationId}`,
        targetAccountType: "Organization",
      },
    });

    const repoProjection = await upsertGithubRepoProjection({
      db,
      installationId,
      repoId,
      fields: {
        currentSlug: `terragon/test-repo-${repoId}`,
      },
    });

    await expect(
      db.insert(schema.githubPrProjection).values({
        prNodeId: `PR_${repoId}_constraint`,
        repoId,
        repoProjectionId: repoProjection.id,
        number: 31,
        status: "draft",
        isDraft: false,
      }),
    ).rejects.toThrow("github_pr_projection_status_is_draft_consistent");
  });
});
