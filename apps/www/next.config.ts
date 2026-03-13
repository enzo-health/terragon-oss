import type { NextConfig } from "next";
import bundleAnalyzer from "@next/bundle-analyzer";

const withBundleAnalyzer = bundleAnalyzer({
  enabled: process.env.ANALYZE === "true",
});

const nextConfig: NextConfig = {
  reactCompiler: true,
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "cdn.terragonlabs.com",
        pathname: "/**",
      },
    ],
  },
  optimizePackageImports: ["lucide-react", "@radix-ui/react-icons"],
  experimental: {
    staleTimes: {
      // Cache dynamic pages for 3 minutes on client-side navigation
      // This makes back/forward navigation instant
      dynamic: 180,
      // Static pages cached for 5 minutes
      static: 300,
    },
    serverActions: {
      bodySizeLimit: "4mb",
    },
  },
  async rewrites() {
    return [];
  },
  async redirects() {
    // Backward compatibility: redirect /chat/:id to /task/:id
    return [
      {
        source: "/chat/:id",
        destination: "/task/:id",
        permanent: false,
      },
    ];
  },
};

export default withBundleAnalyzer(nextConfig);
