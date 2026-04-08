/**
 * UI Source Fetcher
 *
 * Queries the same API that the www UI uses.
 * This validates what users actually see.
 */

import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { ContractRouterClient } from "@orpc/contract";
import { cliAPIContract } from "@terragon/cli-api-contract";
import type { SourceSnapshot, UIWorkflowState } from "../types.js";

export interface UISourceConfig {
  webUrl: string;
  apiKey: string;
  timeoutMs: number;
}

export class UISourceFetcher {
  private client: ContractRouterClient<typeof cliAPIContract>;

  constructor(config: UISourceConfig) {
    const link = new RPCLink({
      url: `${config.webUrl}/api/cli`,
      headers: async () => ({
        "X-Daemon-Token": config.apiKey,
      }),
    });

    this.client = createORPCClient(link);
  }

  async fetchThreadDetail(threadId: string): Promise<SourceSnapshot> {
    const startTime = Date.now();

    try {
      const result = await this.client.threads.detail({
        threadId,
      });

      return {
        name: "ui",
        fetchedAt: new Date(),
        durationMs: Date.now() - startTime,
        data: result,
      };
    } catch (error) {
      return {
        name: "ui",
        fetchedAt: new Date(),
        durationMs: Date.now() - startTime,
        data: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async fetchDeliveryLoopStatus(
    threadId: string,
  ): Promise<SourceSnapshot<UIWorkflowState | null>> {
    const startTime = Date.now();

    try {
      const result = await this.client.threads.deliveryLoopStatus({
        threadId,
      });

      return {
        name: "ui",
        fetchedAt: new Date(),
        durationMs: Date.now() - startTime,
        data: result,
      };
    } catch (error) {
      return {
        name: "ui",
        fetchedAt: new Date(),
        durationMs: Date.now() - startTime,
        data: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async fetchAll(threadId: string): Promise<{
    detail: SourceSnapshot;
    deliveryLoop?: SourceSnapshot<UIWorkflowState | null>;
  }> {
    const detail = await this.fetchThreadDetail(threadId);

    // Try to fetch delivery loop status, but don't fail if unavailable
    let deliveryLoop: SourceSnapshot<UIWorkflowState | null> | undefined;
    try {
      const result = await this.fetchDeliveryLoopStatus(threadId);
      // Only include if data is actually present
      if (result.data) {
        deliveryLoop = result;
      }
    } catch {
      // Delivery loop status might not be available via CLI API yet
    }

    return {
      detail,
      deliveryLoop,
    };
  }
}

export async function createUIFetcher(
  webUrl?: string,
  apiKey?: string,
): Promise<UISourceFetcher> {
  const url = webUrl || process.env.TERRAGON_WEB_URL || "http://127.0.0.1:3000";

  // Read API key from Terry config if not provided
  const key = apiKey || (await readTerryApiKey());

  return new UISourceFetcher({
    webUrl: url,
    apiKey: key,
    timeoutMs: 10000,
  });
}

async function readTerryApiKey(): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const { resolve } = await import("node:path");
  const { homedir } = await import("node:os");

  const settingsDir =
    process.env.TERRY_SETTINGS_DIR?.trim() || `${homedir()}/.terry`;
  const configPath = resolve(settingsDir, "config.json");

  try {
    const configText = await readFile(configPath, "utf-8");
    const parsed = JSON.parse(configText) as { apiKey?: unknown };
    const apiKey = parsed.apiKey;

    if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
      throw new Error(`No API key found in ${configPath}`);
    }

    return apiKey.trim();
  } catch (error) {
    throw new Error(`Failed to read Terry API key: ${error}`);
  }
}
