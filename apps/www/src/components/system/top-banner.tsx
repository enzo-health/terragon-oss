import { ExternalLink } from "lucide-react";
import { BannerBar } from "@/components/system/banner-bar";
import { getBannerConfigAction } from "@/server-actions/unauthed/banner-actions";

export async function TopBanner() {
  const bannerConfig = await getBannerConfigAction();
  if (!bannerConfig?.enabled || !bannerConfig.message) {
    return null;
  }

  const isAnthropicOutage = bannerConfig.message.includes("Anthropic is");

  return (
    <BannerBar
      variant={bannerConfig.variant ?? "default"}
      rightSlot={
        isAnthropicOutage ? (
          <a
            href="https://isanthropicdown.com"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center hover:opacity-80 transition-opacity"
            aria-label="View Anthropic status page"
          >
            <ExternalLink className="size-4" />
          </a>
        ) : undefined
      }
    >
      {bannerConfig.message}
    </BannerBar>
  );
}
