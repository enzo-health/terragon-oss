"use server";

import { revalidateTag } from "next/cache";
import { redis } from "@/lib/redis";
import { adminOnly } from "@/lib/auth-server";
import { User } from "@terragon/shared";
import { BannerConfig, BANNER_KEY } from "@/lib/banner";

export const getRawBannerConfigAction = adminOnly(
  async function getRawBannerConfigAction(adminUser: User) {
    try {
      // Get raw banner config from Redis without any fallbacks
      const config = await redis.get<BannerConfig>(BANNER_KEY);
      return config;
    } catch (error) {
      console.error("Failed to get raw banner config from Redis:", error);
      return null;
    }
  },
);

export const updateBannerConfigAction = adminOnly(
  async function updateBannerConfigAction(
    adminUser: User,
    config: BannerConfig,
  ) {
    try {
      await redis.set(BANNER_KEY, config);
      revalidateTag("banner-config", "max");
      return { success: true };
    } catch (error) {
      console.error("Failed to update banner config in Redis:", error);
      return { success: false, error: "Failed to update banner configuration" };
    }
  },
);

export const deleteBannerConfigAction = adminOnly(
  async function deleteBannerConfigAction(adminUser: User) {
    try {
      await redis.del(BANNER_KEY);
      revalidateTag("banner-config", "max");
      return { success: true };
    } catch (error) {
      console.error("Failed to delete banner config from Redis:", error);
      return { success: false, error: "Failed to delete banner configuration" };
    }
  },
);
