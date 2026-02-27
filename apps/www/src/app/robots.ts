import { MetadataRoute } from "next";
import { publicAppUrl } from "@terragon/env/next-public";

export default function robots(): MetadataRoute.Robots {
  const baseUrl = publicAppUrl();
  return {
    rules: {
      userAgent: "*",
      disallow: ["/"],
    },
    sitemap: `${baseUrl}/sitemap.xml`,
  };
}
