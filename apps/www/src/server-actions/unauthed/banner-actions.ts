"use server";

import { redis } from "@/lib/redis";
import { BannerConfig, BANNER_KEY } from "@/lib/banner";
import { getAnthropicStatusAction } from "./anthropic-status-actions";

export async function getBannerConfigAction(): Promise<BannerConfig | null> {
  try {
    const config = await redis.get<BannerConfig>(BANNER_KEY);

    // If there's an existing banner, return it
    if (config?.enabled) {
      return config;
    }

    // Otherwise, check Anthropic status
    const anthropicStatus = await getAnthropicStatusAction();
    if (
      anthropicStatus?.hasClaudeCodeOutage &&
      anthropicStatus.outageImpact !== "none"
    ) {
      // Show yellow warning for any kind of outage
      const message = "⚠️ Anthropic is experiencing an outage.";
      const variant = "warning";

      return {
        message,
        variant,
        enabled: true,
      };
    }

    return config;
  } catch (error) {
    // Silence expected error during Next.js static generation probing
    const msg = error instanceof Error ? error.message : "";
    if (!msg.includes("DYNAMIC_SERVER_USAGE")) {
      console.error("Failed to get banner config from Redis:", error);
    }
    return null;
  }
}
