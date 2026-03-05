"use server";

import { userOnlyAction } from "@/lib/auth-server";
import { db } from "@/lib/db";
import {
  getEnvironment,
  updateEnvironment,
  markSnapshotsStale,
} from "@terragon/shared/model/environments";
import { encryptValue } from "@terragon/utils/encryption";
import { env } from "@terragon/env/apps-www";
import { McpConfig, validateMcpConfig } from "@terragon/sandbox/mcp-config";
import { getPostHogServer } from "@/lib/posthog-server";
import { UserFacingError } from "@/lib/server-actions";

export const updateMcpConfig = userOnlyAction(
  async function updateMcpConfig(
    userId: string,
    {
      environmentId,
      mcpConfig,
    }: {
      environmentId: string;
      mcpConfig: McpConfig;
    },
  ) {
    // Verify the user owns this environment
    const existingEnvironment = await getEnvironment({
      db,
      environmentId,
      userId,
    });
    if (!existingEnvironment) {
      throw new UserFacingError("Environment not found");
    }

    // Validate the MCP config using the shared validator
    const validationResult = validateMcpConfig(mcpConfig);
    if (!validationResult.success) {
      throw new UserFacingError(validationResult.error);
    }

    // Encrypt the MCP config before storing
    const encryptedConfig = encryptValue(
      JSON.stringify(mcpConfig),
      env.ENCRYPTION_MASTER_KEY,
    );

    // Update the environment with the encrypted MCP config
    await updateEnvironment({
      db,
      userId,
      environmentId,
      updates: {
        mcpConfigEncrypted: encryptedConfig,
      },
    });
    await markSnapshotsStale({
      db,
      userId,
      environmentId,
    });

    // Track MCP config save
    const mcpServerNames = mcpConfig?.mcpServers
      ? Object.keys(mcpConfig.mcpServers).filter((name) => name !== "terry")
      : [];

    getPostHogServer().capture({
      distinctId: userId,
      event: "mcp_config_saved",
      properties: {
        environmentId,
        repoFullName: existingEnvironment.repoFullName,
        mcpServerNames,
        mcpServerCount: mcpServerNames.length,
      },
    });

    return { success: true };
  },
  { defaultErrorMessage: "Failed to update MCP config" },
);
