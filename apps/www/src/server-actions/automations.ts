"use server";

import { userOnlyAction } from "@/lib/auth-server";
import { db } from "@/lib/db";
import { AutomationInsert } from "@terragon/shared";
import {
  createAutomation as createAutomationModel,
  getAutomations as getAutomationsModel,
  deleteAutomation as deleteAutomationModel,
  updateAutomation as updateAutomationModel,
  getAutomation as getAutomationModel,
} from "@terragon/shared/model/automations";
import {
  runAutomation as runAutomationInternal,
  runPullRequestAutomation as runPullRequestAutomationInternal,
  runIssueAutomation as runIssueAutomationInternal,
  validateAutomationCreationOrUpdate,
  validateCanRunAutomation,
  hasReachedLimitOfAutomations,
} from "@/server-lib/automations";

export const getHasReachedLimitOfAutomations = userOnlyAction(
  async function getHasReachedLimitOfAutomations(userId: string) {
    return await hasReachedLimitOfAutomations({ userId });
  },
  { defaultErrorMessage: "An unexpected error occurred" },
);

export const getAutomations = userOnlyAction(
  async function getAutomations(userId: string) {
    return await getAutomationsModel({ db, userId });
  },
  { defaultErrorMessage: "Failed to get automations" },
);

export const getAutomation = userOnlyAction(
  async function getAutomation(userId: string, automationId: string) {
    const automation = await getAutomationModel({ db, automationId, userId });
    return automation;
  },
  { defaultErrorMessage: "Failed to get automation" },
);

export const createAutomation = userOnlyAction(
  async function createAutomation(
    userId: string,
    { automation }: { automation: Omit<AutomationInsert, "userId"> },
  ) {
    console.log("createAutomation", automation);
    await validateAutomationCreationOrUpdate({
      userId,
      automationId: null,
      updates: automation,
    });
    await createAutomationModel({
      db,
      userId,
      accessTier: "pro",
      automation,
    });
  },
  { defaultErrorMessage: "Failed to create automation" },
);

export const deleteAutomation = userOnlyAction(
  async function deleteAutomation(userId: string, automationId: string) {
    await deleteAutomationModel({ db, automationId, userId });
  },
  { defaultErrorMessage: "Failed to delete automation" },
);

export const enableOrDisableAutomation = userOnlyAction(
  async function enableOrDisableAutomation(
    userId: string,
    { automationId, enabled }: { automationId: string; enabled: boolean },
  ) {
    await validateAutomationCreationOrUpdate({
      userId,
      automationId,
      updates: { enabled },
    });
    await updateAutomationModel({
      db,
      automationId,
      userId,
      accessTier: "pro",
      updates: { enabled },
    });
  },
  {
    defaultErrorMessage: "Failed to update automation",
  },
);

export const updateAutomation = userOnlyAction(
  async function updateAutomation(
    userId: string,
    {
      automationId,
      updates,
    }: {
      automationId: string;
      updates: Omit<
        AutomationInsert,
        "userId" | "createdAt" | "updatedAt" | "lastRunAt" | "runCount"
      >;
    },
  ) {
    await validateAutomationCreationOrUpdate({
      userId,
      automationId,
      updates,
    });
    await updateAutomationModel({
      db,
      automationId,
      userId,
      accessTier: "pro",
      updates,
    });
  },
  {
    defaultErrorMessage: "Failed to update automation",
  },
);

export const runAutomation = userOnlyAction(
  async function runAutomation(userId: string, automationId: string) {
    await validateCanRunAutomation({
      userId,
      automationId,
      triggerTypes: ["manual", "schedule"],
      throwOnError: true,
    });
    await runAutomationInternal({ userId, automationId, source: "manual" });
  },
  {
    defaultErrorMessage: "Failed to run automation",
  },
);

export const runPullRequestAutomation = userOnlyAction(
  async function runPullRequestAutomation(
    userId: string,
    { automationId, prNumber }: { automationId: string; prNumber: number },
  ) {
    const { automation } = await validateCanRunAutomation({
      userId,
      automationId,
      triggerTypes: ["pull_request"],
      throwOnError: true,
    });
    await runPullRequestAutomationInternal({
      userId,
      automationId,
      prNumber,
      repoFullName: automation.repoFullName,
      prEventAction: "opened",
      source: "manual",
    });
  },
  { defaultErrorMessage: "Failed to run pull request automation" },
);

export const runIssueAutomation = userOnlyAction(
  async function runIssueAutomation(
    userId: string,
    {
      automationId,
      issueNumber,
    }: { automationId: string; issueNumber: number },
  ) {
    const { automation } = await validateCanRunAutomation({
      userId,
      automationId,
      triggerTypes: ["issue"],
      throwOnError: true,
    });
    await runIssueAutomationInternal({
      userId,
      automationId,
      issueNumber,
      repoFullName: automation.repoFullName,
      issueEventAction: "opened",
      source: "manual",
    });
  },
  { defaultErrorMessage: "Failed to run issue automation" },
);
