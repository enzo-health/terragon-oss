"use server";

import { unstable_cache } from "next/cache";
import { redis } from "@/lib/redis";
import { BannerConfig, BANNER_KEY } from "@/lib/banner";
import { getAnthropicStatusAction } from "./anthropic-status-actions";

const getCachedBannerConfig = unstable_cache(
  async (): Promise<BannerConfig | null> => {
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
        return {
          message: "⚠️ Anthropic is experiencing an outage.",
          variant: "warning",
          enabled: true,
        };
      }

      return config;
    } catch (error) {
      console.error("Failed to get banner config from Redis:", error);
      return null;
    }
  },
  ["banner-config"],
  {
    revalidate: 30,
    tags: ["banner-config"],
  },
);

export async function getBannerConfigAction(): Promise<BannerConfig | null> {
  try {
    return await getCachedBannerConfig();
  } catch (error) {
    console.error("Failed to get banner config from Redis:", error);
    return null;
  }
}
