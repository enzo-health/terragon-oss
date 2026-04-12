"use server";

import { LinearClient } from "@linear/sdk";
import { userOnlyAction } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { getLinearAccounts } from "@terragon/shared/model/linear";
import { refreshLinearTokenIfNeeded } from "@/server-lib/linear-oauth";
import {
  createTriageTicketForComment,
  createBulkTriageTicket,
  type ReviewCommentPriority,
} from "@/server-lib/review-linear-triage";

// ---------------------------------------------------------------------------
// getLinearTeamsAction — fetch available Linear teams for the team picker
// ---------------------------------------------------------------------------

export const getLinearTeamsAction = userOnlyAction(
  async function getLinearTeamsAction(
    userId: string,
  ): Promise<Array<{ id: string; name: string; key: string }>> {
    const accounts = await getLinearAccounts({ db, userId });
    if (accounts.length === 0) {
      throw new Error(
        "No Linear account linked. Please connect your Linear account in Settings.",
      );
    }

    const account = accounts[0]!;
    const tokenResult = await refreshLinearTokenIfNeeded(
      account.organizationId,
      db,
    );
    if (tokenResult.status !== "ok") {
      throw new Error(
        "Linear installation token is unavailable. Please reinstall the Linear agent in Settings.",
      );
    }

    const client = new LinearClient({ accessToken: tokenResult.accessToken });
    const teamsConnection = await client.teams();
    return teamsConnection.nodes.map((team) => ({
      id: team.id,
      name: team.name,
      key: team.key,
    }));
  },
  { defaultErrorMessage: "Failed to fetch Linear teams" },
);

// ---------------------------------------------------------------------------
// createTriageTicketAction — create triage ticket(s) for PR review comments
// ---------------------------------------------------------------------------

export const createTriageTicketAction = userOnlyAction(
  async function createTriageTicketAction(
    userId: string,
    params: {
      teamId: string;
    } & (
      | {
          mode: "single";
          comment: {
            id: string;
            file: string;
            line: number | null;
            priority: ReviewCommentPriority;
            body: string;
          };
          review: {
            prNumber: number;
            prUrl: string;
            prTitle: string;
            repoFullName: string;
          };
        }
      | {
          mode: "bulk";
          comments: Array<{
            file: string;
            line: number | null;
            priority: ReviewCommentPriority;
            body: string;
          }>;
          review: {
            id: string;
            prNumber: number;
            prUrl: string;
            prTitle: string;
            repoFullName: string;
          };
        }
    ),
  ): Promise<{ ticketUrl: string }> {
    if (params.mode === "single") {
      return createTriageTicketForComment({
        comment: params.comment,
        review: params.review,
        teamId: params.teamId,
        userId,
      });
    }

    return createBulkTriageTicket({
      comments: params.comments,
      review: params.review,
      teamId: params.teamId,
      userId,
    });
  },
  { defaultErrorMessage: "Failed to create triage ticket" },
);
