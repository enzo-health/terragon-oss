import { MetadataRoute } from "next";
import { publicAppUrl } from "@terragon/env/next-public";

export default function sitemap(): MetadataRoute.Sitemap {
  const baseUrl = publicAppUrl();
  return [
    {
      url: `${baseUrl}/login`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 0.4,
    },
  ];
}
