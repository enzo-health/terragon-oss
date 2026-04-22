import path from "node:path";
import { fileURLToPath } from "node:url";
import bundleAnalyzer from "@next/bundle-analyzer";
import { config as loadDotenv } from "dotenv";
import type { NextConfig } from "next";

// Turbopack can mis-handle inherited NODE_PATH values from shell wrappers and
// treat a delimiter-joined list as one lookup directory. This app does not rely
// on NODE_PATH, so strip it at the boundary.
delete process.env.NODE_PATH;

const withBundleAnalyzer = bundleAnalyzer({
  enabled: process.env.ANALYZE === "true",
});

const configDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(configDir, "..", "..");

function loadLocalEnvFiles() {
  const localEnvFiles = [
    path.join(configDir, ".env.local"),
    path.join(configDir, ".env.development.local"),
    path.join(repoRoot, ".env.local"),
    path.join(repoRoot, ".env.development.local"),
  ];

  for (const envPath of localEnvFiles) {
    loadDotenv({
      path: envPath,
      override: false,
    });
  }
}

loadLocalEnvFiles();

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
  turbopack: {
    root: repoRoot,
  },
  experimental: {
    optimizePackageImports: [
      "lucide-react",
      "@radix-ui/react-avatar",
      "@radix-ui/react-checkbox",
      "@radix-ui/react-dialog",
      "@radix-ui/react-dropdown-menu",
      "@radix-ui/react-label",
      "@radix-ui/react-popover",
      "@radix-ui/react-portal",
      "@radix-ui/react-progress",
      "@radix-ui/react-radio-group",
      "@radix-ui/react-scroll-area",
      "@radix-ui/react-select",
      "@radix-ui/react-separator",
      "@radix-ui/react-slot",
      "@radix-ui/react-switch",
      "@radix-ui/react-tabs",
      "@radix-ui/react-tooltip",
      "@radix-ui/react-visually-hidden",
      "@tiptap/react",
      "@tiptap/starter-kit",
      "@assistant-ui/react",
    ],
    staleTimes: {
      // Dev uses minimal caching (30s minimum), prod uses longer caching
      dynamic: process.env.NODE_ENV === "development" ? 30 : 180,
      static: process.env.NODE_ENV === "development" ? 30 : 300,
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

// bundle-analyzer still peer-types against Next 15, so widen here at the edge.
export default withBundleAnalyzer(nextConfig as any);
