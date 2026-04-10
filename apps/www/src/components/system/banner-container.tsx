import { cache } from "react";
import { TopBanner } from "@/components/system/top-banner";
import { BannerBar } from "@/components/system/banner-bar";
import { BannerPriorityGate } from "@/components/system/banner-container.client";
import { db } from "@/lib/db";
import { getFeatureFlagsGlobal } from "@leo/shared/model/feature-flags";
import { publicDocsUrl } from "@leo/env/next-public";
import Link from "next/link";

// Deduplicate across layout segments that both render BannerContainer
const getCachedFeatureFlags = cache(() => getFeatureFlagsGlobal({ db }));

/**
 * Shows at most one banner, in priority order:
 * 1) Shutdown banner (if shutdown mode enabled)
 * 2) Impersonation banner (client-side, if admin is impersonating)
 * 3) Otherwise, the TopBanner (global/admin-configured or outage-driven)
 */
export async function BannerContainer() {
  const flags = await getCachedFeatureFlags();

  // Shutdown banner has highest priority
  if (flags.shutdownMode) {
    return (
      <BannerBar id="shutdown-banner">
        Leo is shutting down on February 9th, 2026.{" "}
        <Link
          href={`${publicDocsUrl()}/docs/resources/shutdown`}
          className="underline"
        >
          Learn more
        </Link>
      </BannerBar>
    );
  }

  return (
    <BannerPriorityGate>
      <TopBanner />
    </BannerPriorityGate>
  );
}
